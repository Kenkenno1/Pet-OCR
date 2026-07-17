const fs = require('node:fs');
const path = require('node:path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const root = process.cwd();
const distRoot = path.join(root, 'dist');
const configPath = path.join(root, '.pages-build.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const baseObfuscationOptions = Object.freeze({
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  seed: Number(config.seed || 20260717),
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64', 'rc4'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayThreshold: 0.75,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersType: 'function',
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
});

const report = [];

fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(distRoot, { recursive: true });

for (const relativePath of config.copy || []) copyEntry(relativePath);
for (const relativePath of config.html || []) buildHtml(relativePath);
for (const relativePath of config.javascript || []) buildJavaScript(relativePath);
for (const relativePath of config.css || []) buildCss(relativePath);

verifyDist();
for (const entry of report) {
  console.log(`${entry.kind}: ${entry.path} (${entry.inputBytes} -> ${entry.outputBytes} bytes)`);
}
console.log(`Built ${report.length} transformed files into ${distRoot}`);

function resolveInside(base, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Expected a non-empty relative path, received: ${relativePath}`);
  }
  const resolvedBase = path.resolve(base);
  const resolvedPath = path.resolve(base, relativePath);
  const prefix = `${resolvedBase}${path.sep}`;
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(prefix)) {
    throw new Error(`Path escapes build root: ${relativePath}`);
  }
  return resolvedPath;
}

function copyEntry(relativePath) {
  const sourcePath = resolveInside(root, relativePath);
  const targetPath = resolveInside(distRoot, relativePath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Missing copy entry: ${relativePath}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.cpSync(sourcePath, targetPath, { recursive: true });
}

function buildHtml(relativePath) {
  const sourcePath = resolveInside(root, relativePath);
  const targetPath = resolveInside(distRoot, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  let scriptCount = 0;
  let output = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attributes, code) => {
    if (/\bsrc\s*=/i.test(attributes) || shouldSkipInlineScript(attributes, code)) return match;
    scriptCount += 1;
    return `<script${attributes}>${obfuscate(code, relativePath)}</script>`;
  });
  output = output.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_, attributes, css) => {
    return `<style${attributes}>${minifyCss(css)}</style>`;
  });
  output = output
    .replace(/<!--(?!\[if)[\s\S]*?-->/gi, '')
    .replace(/^[\t ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');

  if (scriptCount === 0 && config.requireInlineScripts !== false && !hasConfiguredExternalScript(relativePath)) {
    throw new Error(`No first-party script was transformed in ${relativePath}`);
  }
  writeBuiltFile(targetPath, output);
  report.push({ kind: `html/${scriptCount}-scripts`, path: relativePath, inputBytes: Buffer.byteLength(source), outputBytes: Buffer.byteLength(output) });
}

function shouldSkipInlineScript(attributes, code) {
  if (!code.trim()) return true;
  const typeMatch = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
  const type = (typeMatch?.[1] || '').toLowerCase();
  return ['application/json', 'application/ld+json', 'importmap', 'text/template'].includes(type);
}

function hasConfiguredExternalScript(relativePath) {
  const normalized = normalize(relativePath);
  return (config.externalScriptHosts || []).some(entry => normalize(entry.html) === normalized);
}

function buildJavaScript(relativePath) {
  const sourcePath = resolveInside(root, relativePath);
  const targetPath = resolveInside(distRoot, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = obfuscate(source, relativePath);
  writeBuiltFile(targetPath, output);
  report.push({ kind: 'javascript', path: relativePath, inputBytes: Buffer.byteLength(source), outputBytes: Buffer.byteLength(output) });
}

function buildCss(relativePath) {
  const sourcePath = resolveInside(root, relativePath);
  const targetPath = resolveInside(distRoot, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = minifyCss(source);
  writeBuiltFile(targetPath, output);
  report.push({ kind: 'css', path: relativePath, inputBytes: Buffer.byteLength(source), outputBytes: Buffer.byteLength(output) });
}

function obfuscate(source, relativePath) {
  const overrides = config.javascriptOptions?.[normalize(relativePath)] || {};
  const output = JavaScriptObfuscator.obfuscate(source, {
    ...baseObfuscationOptions,
    ...overrides,
  }).getObfuscatedCode();
  const markerCount = (output.match(/_0x[0-9a-f]{3,}/gi) || []).length;
  if (markerCount < 25) {
    throw new Error(`Obfuscation marker check failed for ${relativePath}: ${markerCount}`);
  }
  if (/sourceMappingURL/i.test(output)) {
    throw new Error(`Source map reference found in ${relativePath}`);
  }
  return output;
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>~+])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function writeBuiltFile(targetPath, contents) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, 'utf8');
}

function normalize(relativePath) {
  return relativePath.replaceAll('\\', '/');
}

function verifyDist() {
  const forbidden = [
    /(^|\/)\.git(?:hub)?(\/|$)/i,
    /(^|\/)node_modules(\/|$)/i,
    /(^|\/)scripts(\/|$)/i,
    /(^|\/)tests?(\/|$)/i,
    /(^|\/)worker(\/|$)/i,
    /(^|\/)dist(\/|$)/i,
    /(^|\/)README(?:\.|$)/i,
    /backup/i,
    /package(?:-lock)?\.json$/i,
    /\.map$/i,
    /\.(?:cmd|ps1|mjs|cjs)$/i,
  ];
  const files = listFiles(distRoot);
  if (!files.length) throw new Error('dist is empty');
  for (const relativePath of files) {
    if (forbidden.some(pattern => pattern.test(relativePath))) {
      throw new Error(`Forbidden development file in dist: ${relativePath}`);
    }
  }
  for (const entry of [...(config.html || []), ...(config.javascript || []), ...(config.css || [])]) {
    if (!fs.existsSync(resolveInside(distRoot, entry))) throw new Error(`Missing transformed output: ${entry}`);
  }
}

function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = normalize(path.join(prefix, entry.name));
    if (entry.isDirectory()) files.push(...listFiles(path.join(directory, entry.name), relativePath));
    else files.push(relativePath);
  }
  return files;
}
