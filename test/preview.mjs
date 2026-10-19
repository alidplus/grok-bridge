// Renders the webview outside Cursor with a fake host and a dark theme, for screenshots:
//   node test/preview.mjs && google-chrome --headless --window-size=420,900 --screenshot=.test-storage/preview.png .test-storage/preview.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, ".test-storage"); fs.mkdirSync(out, { recursive: true });
const view = process.argv[2] || "chat";
const theme = `:root{--vscode-font-family:system-ui,Ubuntu,"Segoe UI",sans-serif;--vscode-editor-font-family:"Ubuntu Mono","DejaVu Sans Mono",monospace;--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;
--vscode-widget-border:#313131;--vscode-input-background:#1f1f1f;--vscode-input-border:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;
--vscode-textCodeBlock-background:#2b2b2b;--vscode-button-background:#cccccc;--vscode-button-foreground:#1f1f1f;--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-errorForeground:#f85149;
--vscode-inputValidation-errorBackground:#5a1d1d;--vscode-inputValidation-errorBorder:#be1100;--vscode-charts-green:#89d185}body{background:#181818}`;
const now = Date.now();
const fake = `
const now=${now};
const turns=[{user:"I'm looking for an agent with this id: \`agent-4e4521d5\`",durationMs:74000,items:[
 {kind:"thinking",text:"Searching local SDK agents for the id."},{kind:"tool",name:"glob",status:"completed",detail:"**/.cursor/agents/*"},{kind:"tool",name:"shell",status:"completed",detail:"node ask.mjs --list"},
 {kind:"text",text:"That matches what is on disk. \`agent-4e4521d5\` is a **local** \`@cursor/sdk\` agent, model **grok-4.5**, created in this playground at 9:15 AM.\\n\\nThe prompt that started it:\\n\\n> Write a clear, complete README.md for this project. Only edit README.md.\\n\\n- It finished in **one run**\\n- Transcript: [SDK docs](https://cursor.com/docs/sdk/typescript)\\n\\n\`\`\`js\\nconst agent = await Agent.create({ model: { id: \\"grok-4.5\\" } });\\n\`\`\`\\n\\nWhat do you want next: resume that agent, or open its transcript?"}]}];
const run={agentId:"agent-demo",runId:"run-1",prompt:"Add a --json flag to ask.mjs",source:"mcp",startedAt:now-12000,events:[{kind:"thinking",text:"Reading ask.mjs first."},{kind:"tool",callId:"a",name:"read",status:"completed",detail:"ask.mjs"},{kind:"tool",callId:"b",name:"edit",status:"running",detail:"ask.mjs"},{kind:"text",text:"I'm adding the flag now; output stays the same without it."}]};
window.acquireVsCodeApi=()=>({getState:()=>null,setState(){},postMessage(m){setTimeout(()=>{
 if(m.type==="init"){post({type:"init",cwd:"/home/ali/www/cursor-sdk-play",model:"grok-4.5",mcp:{state:"on",url:"http://127.0.0.1:7457/mcp"},runs:[run],titles:{"agent-demo":"Add a --json flag to ask.mjs"}});
   post({type:"models",models:[{id:"claude-opus-5",name:"Claude Opus 5"},{id:"grok-4.5",name:"Grok 4.5"},{id:"grok-4.7",name:"Grok 4.7"}]});
   setTimeout(()=>{ if("${view}"==="history") show("history"); else if("${view}"==="chat") openAgent("agent-demo"); },30);}
 if(m.type==="messages") post({type:"messages",agentId:m.agentId,turns,title:"Find agent-4e4521d5"});
 if(m.type==="list") post({type:"list",cwd:m.cwd,items:[{agentId:"agent-demo",title:"Add a --json flag to ask.mjs",lastModified:now-20000,running:true},{agentId:"agent-4e4521d5-c31e",title:"Find agent-4e4521d5",lastModified:now-3600e3,status:"finished"},{agentId:"agent-e2c6d23b-116b",title:"Write a README for this project",lastModified:now-86400e3*2,status:"finished"}]});
},5);}});
function post(d){window.dispatchEvent(new MessageEvent("message",{data:d}));}`;
let html = fs.readFileSync(path.join(root, "media/panel.html"), "utf8")
  .replace(/<meta http-equiv[^>]+>/, "")
  .replace("{{style}}", "../media/panel.css")
  .replace(/<script nonce="\{\{nonce\}\}" src="\{\{script\}\}"><\/script>/, `<script>${fake}</script><script src="../media/panel.js"></script>`)
  .replace("</head>", `<style>${theme}</style></head>`);
fs.writeFileSync(path.join(out, `preview-${view}.html`), html);
console.log(path.join(out, `preview-${view}.html`));
