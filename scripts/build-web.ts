import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {basename} from 'node:path';

// Entry/chunk names change with their content; remove obsolete chunks so the
// embedded release never grows with each build. Run from web/ via bun run build.
await rm('dist',{recursive:true,force:true});
const result=await Bun.build({
  entrypoints:['src/workspace.ts','src/webterm/terminal.ts'],
  outdir:'dist/static/js',target:'browser',minify:true,splitting:true,
  naming:{entry:'[name]-[hash].[ext]',chunk:'chunk-[hash].[ext]'},
});
if(!result.success)throw new AggregateError(result.logs,'Frontend build failed');
const theme=await Bun.build({
  entrypoints:['src/theme.ts'],outdir:'dist/static/js',target:'browser',format:'iife',minify:true,
  naming:{entry:'[name]-[hash].[ext]'},
});
if(!theme.success)throw new AggregateError(theme.logs,'Theme bootstrap build failed');
const outputs=[...result.outputs,...theme.outputs];
await cp('assets','dist/static',{recursive:true});
await cp('../licenses','dist/static/licenses',{recursive:true});
await cp('../THIRD_PARTY_NOTICES.md','dist/static/THIRD_PARTY_NOTICES.md');
await cp('node_modules/ghostty-web/ghostty-vt.wasm','dist/static/js/ghostty-vt.wasm');
const revision=async(path:string)=>createHash('sha256').update(await readFile('dist/'+path)).digest('hex');
const font='static/fonts/FiraCodeNerdFont-Regular.woff2';
const css=await readFile('dist/static/monospace.css','utf8');
await writeFile('dist/static/monospace.css',css.replaceAll('fonts/FiraCodeNerdFont-Regular.woff2',`fonts/FiraCodeNerdFont-Regular.woff2?v=${await revision(font)}`));
let index=await readFile('index.html','utf8');
for(const name of ['monospace.css','workspace.css'])index=index.replace(`static/${name}`,`static/${name}?v=${await revision('static/'+name)}`);
function entry(name:string){
 const file=outputs.find(output=>output.kind==='entry-point'&&basename(output.path).startsWith(name+'-'));
 if(!file)throw Error(`Missing ${name} entry`);return 'static/js/'+basename(file.path);
}
index=index.replace('static/js/workspace.js',entry('workspace'));
index=index.replace('static/js/theme.js',entry('theme'));
const wasm='static/js/ghostty-vt.wasm';
index=index.replace('  <link rel="stylesheet"',`  <link rel="preload" href="${wasm}?v=${await revision(wasm)}" as="fetch" type="application/wasm" crossorigin>\n  <link rel="modulepreload" href="${entry('terminal')}">\n  <link rel="stylesheet"`);
await mkdir('dist',{recursive:true});await writeFile('dist/index.html',index);
for(const file of outputs)console.log(`${basename(file.path)}: ${file.size} bytes`);
