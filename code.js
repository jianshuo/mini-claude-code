import OpenAI from "openai";
import fs from "fs";
import path from "path";
import readline from "readline";

const client = new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: "https://api.moonshot.cn/v1" });

const fn = (name, desc, props, req = []) => ({
    type: "function",
    function: { name, description: desc, parameters: { type: "object", properties: props, required: req } },
});

const TOOLS = [
    fn("read_file", "Read a file.", { path: { type: "string" } }, ["path"]),
    fn("list_files", "List files in a directory.", { path: { type: "string" } }),
    fn("edit_file", "Write content to a file.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
];

function runTool(name, input) {
    try {
        if (name === "read_file") return fs.readFileSync(input.path, "utf8");
        if (name === "list_files") return fs.readdirSync(input.path ? ? ".").sort().join("\n");
        if (name === "edit_file") {
            fs.mkdirSync(path.dirname(path.resolve(input.path)), { recursive: true });
            fs.writeFileSync(input.path, input.content);
            return `Wrote ${input.content.length} bytes to ${input.path}`;
        }
    } catch (e) { return `Error: ${e.message}`; }
}

async function agentLoop(userMessage, history) {
    history.push({ role: "user", content: userMessage });
    while (true) {
        const { choices } = await client.chat.completions.create({ model: "moonshot-v1-8k", tools: TOOLS, tool_choice: "auto", messages: history });
        const msg = choices[0].message;
        history.push(msg);
        if (msg.content) console.log(`\nAssistant: ${msg.content}`);
        if (!msg.tool_calls ? .length) return;
        for (const tc of msg.tool_calls) {
            const input = JSON.parse(tc.function.arguments);
            console.log(`  → ${tc.function.name}(${tc.function.arguments})`);
            const out = runTool(tc.function.name, input);
            console.log(`  ← ${String(out).slice(0, 120)}`);
            history.push({ role: "tool", tool_call_id: tc.id, content: out });
        }
    }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));
const history = [{ role: "system", content: "You are a coding assistant. Usea tools to read, list, and edit files — never guess file contents. Always call a tool when the task involves the filesystem. Always output code into filesystem" }];
console.log("Mini Code Assistant (Kimi) — press Ctrl+C to exit\n");
while (true) {
    const msg = (await ask("You: ")).trim();
    if (msg) await agentLoop(msg, history);
}


[
    { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: [Object] } }
]