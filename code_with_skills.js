import OpenAI from "openai";
import fs from "fs";
import path from "path";
import readline from "readline";
import os from "os";

const client = new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: "https://api.moonshot.cn/v1" });

// --- Tools ---
const fn = (name, desc, props, req = []) => ({
    type: "function",
    function: { name, description: desc, parameters: { type: "object", properties: props, required: req } },
});

const TOOLS = [
    fn("read_file",  "Read a file.",               { path: { type: "string" } },                               ["path"]),
    fn("list_files", "List files in a directory.", { path: { type: "string" } }),
    fn("edit_file",  "Write content to a file.",   { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
];

function runTool(name, input) {
    try {
        if (name === "read_file")  return fs.readFileSync(input.path, "utf8");
        if (name === "list_files") return fs.readdirSync(input.path ?? ".").sort().join("\n");
        if (name === "edit_file") {
            fs.mkdirSync(path.dirname(path.resolve(input.path)), { recursive: true });
            fs.writeFileSync(input.path, input.content);
            return `Wrote ${input.content.length} bytes to ${input.path}`;
        }
    } catch (e) { return `Error: ${e.message}`; }
}

// --- Frontmatter parser ---
// Handles: simple scalars, block scalars (|), and sequence lists (- item)
function parseFrontmatter(text) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: text };

    const lines = match[1].split("\n");
    const body = match[2];
    const meta = {};
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const kv = line.match(/^([\w][\w-]*)\s*:\s*(.*)/);
        if (!kv) { i++; continue; }

        const key = kv[1];
        const val = kv[2].trim();

        if (val === "|" || val === ">") {
            // Block scalar: collect indented lines
            i++;
            const indentLen = lines[i]?.match(/^( +)/)?.[1]?.length ?? 2;
            const block = [];
            while (i < lines.length && (lines[i].startsWith(" ".repeat(indentLen)) || lines[i].trim() === "")) {
                block.push(lines[i].slice(indentLen));
                i++;
            }
            meta[key] = block.join("\n").trimEnd();
        } else if (val === "") {
            // Possible list
            const items = [];
            i++;
            while (i < lines.length && /^\s+-\s/.test(lines[i])) {
                items.push(lines[i].replace(/^\s+-\s+/, "").trim());
                i++;
            }
            meta[key] = items.length ? items : "";
        } else {
            meta[key] = val;
            i++;
        }
    }

    return { meta, body };
}

// --- Skill loader ---
function loadSkills(skillsDir) {
    const skills = new Map();
    if (!fs.existsSync(skillsDir)) return skills;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const entry of entries) {
        const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        try {
            const raw = fs.readFileSync(skillFile, "utf8");
            const { meta } = parseFrontmatter(raw);
            const name = meta.name ?? entry.name;
            const description = typeof meta.description === "string" ? meta.description : "";
            const triggers = Array.isArray(meta.triggers) ? meta.triggers : [];
            skills.set(name, { name, description, triggers, raw });
        } catch (_) { /* skip unreadable */ }
    }
    return skills;
}

// --- Trigger matching ---
// Returns the best-matching skill for a user message, or null.
function matchTrigger(msg, skills) {
    const lower = msg.toLowerCase();
    for (const skill of skills.values()) {
        // Check explicit triggers list first
        for (const t of skill.triggers) {
            if (lower.includes(t.toLowerCase())) return skill;
        }
        // Then scan description for "Triggers —" patterns
        const triggerSection = skill.description.match(/[Tt]riggers[^:：]*[:：]\s*([^\n]+)/);
        if (triggerSection) {
            const phrases = triggerSection[1].split(/[,、，]/).map(p => p.trim().replace(/^["「『]|["」』]$/g, ""));
            for (const p of phrases) {
                if (p && p.length > 3 && lower.includes(p.toLowerCase())) return skill;
            }
        }
    }
    return null;
}

// --- Agent loop ---
async function agentLoop(userMessage, history) {
    history.push({ role: "user", content: userMessage });
    while (true) {
        const { choices } = await client.chat.completions.create({
            model: "moonshot-v1-8k",
            tools: TOOLS,
            tool_choice: "auto",
            messages: history,
        });
        const msg = choices[0].message;
        history.push(msg);
        if (msg.content) console.log(`\nAssistant: ${msg.content}`);
        if (!msg.tool_calls?.length) return;
        for (const tc of msg.tool_calls) {
            const input = JSON.parse(tc.function.arguments);
            console.log(`  → ${tc.function.name}(${tc.function.arguments})`);
            const out = runTool(tc.function.name, input);
            console.log(`  ← ${String(out).slice(0, 200)}`);
            history.push({ role: "tool", tool_call_id: tc.id, content: String(out) });
        }
    }
}

// --- Main ---
const SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const skills = loadSkills(SKILLS_DIR);

const SYSTEM_PROMPT =
    "You are a coding assistant. You MUST use tools to perform ALL filesystem operations — " +
    "never describe, narrate, or show bash commands as text. " +
    "When a task involves the filesystem, call read_file / list_files / edit_file immediately. " +
    "Do not explain what you are going to do — just do it with a tool call.\n\n" +
    `${skills.size} skills are available. When a skill is activated via a system message, ` +
    "follow its instructions by executing actions with tools, not by describing them.";

const history = [{ role: "system", content: SYSTEM_PROMPT }];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

console.log(`Mini Code Assistant — ${skills.size} skills loaded — Ctrl+C to exit`);
console.log(`  /list          show all skills`);
console.log(`  /search <q>    search skills by keyword`);
console.log(`  /skill-name    invoke a skill\n`);

while (true) {
    const raw = (await ask("You: ")).trim();
    if (!raw) continue;

    // /list
    if (raw === "/list" || raw === "/?") {
        console.log(`\n${skills.size} skills:\n`);
        for (const s of skills.values()) {
            const snippet = s.description.split("\n")[0].slice(0, 90);
            console.log(`  /${s.name.padEnd(36)} ${snippet}`);
        }
        console.log();
        continue;
    }

    // /search <query>
    if (raw.startsWith("/search ")) {
        const q = raw.slice(8).trim().toLowerCase();
        const found = [...skills.values()].filter(s =>
            s.name.includes(q) || s.description.toLowerCase().includes(q)
        );
        console.log(`\n${found.length} skill(s) matching "${q}":\n`);
        for (const s of found) {
            const snippet = s.description.split("\n")[0].slice(0, 90);
            console.log(`  /${s.name.padEnd(36)} ${snippet}`);
        }
        console.log();
        continue;
    }

    // /skill-name [message]
    if (raw.startsWith("/")) {
        const [slashName, ...rest] = raw.slice(1).split(" ");
        const skill = skills.get(slashName);
        if (skill) {
            console.log(`\n[Skill: ${skill.name}]\n`);
            history.push({ role: "system", content: `Skill "${skill.name}" activated:\n\n${skill.raw}` });
            history.push({ role: "system", content: "IMPORTANT: Execute the skill's steps using tool calls. Do NOT narrate or describe — call tools directly." });
            const followUp = rest.join(" ").trim();
            if (followUp) await agentLoop(followUp, history);
            continue;
        }
        // Unknown slash command — fall through to model
    }

    // Trigger auto-detection
    const triggered = matchTrigger(raw, skills);
    if (triggered) {
        console.log(`\n[Auto-detected skill: ${triggered.name}]\n`);
        history.push({ role: "system", content: `Skill "${triggered.name}" activated:\n\n${triggered.raw}` });
        history.push({ role: "system", content: "IMPORTANT: Execute the skill's steps using tool calls. Do NOT narrate or describe — call tools directly." });
    }

    await agentLoop(raw, history);
}
