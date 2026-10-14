// Placeholder for commands whose implementation is scheduled in a later backlog task.
const [command = "command", task = "a later task"] = process.argv.slice(2);
console.error(`pnpm ${command}: not implemented yet (${task}). No action was taken.`);
process.exit(2);
