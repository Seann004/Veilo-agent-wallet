import { readFile, writeFile } from 'node:fs/promises'

const pages = [
  ['index.md', 'Overview', 'Product purpose, owner-created agents, user flow and benefits.'],
  ['guide/agents.md', 'Agent workflows', 'Custom agents and example research, credit and content workflows.'],
  ['guide/architecture.md', 'Architecture', 'Planning, policy, wallet, pool, settlement and service boundaries.'],
  ['guide/payments.md', 'Payment lifecycle', 'Private funding, exact x402 payments, credits and reconciliation.'],
  ['guide/policy.md', 'Policy and accounting', 'Permission tiers, atomic reservations, caps and revocation.'],
  ['guide/privacy.md', 'Privacy and trust', 'Deposit linkage privacy, public metadata and off-chain visibility.'],
  ['guide/running.md', 'Deployment and configuration', 'Service configuration, network guards and artifact manifests.'],
  ['security/assessment.md', 'Security model', 'Authority separation, authentication and secret isolation.'],
  ['security/risks.md', 'Trust and risk boundaries', 'Residual risks, assumptions and design responses.'],
  ['security/evidence.md', 'Verification requirements', 'Acceptance scenarios; not a report of passed tests.']
]

const index = `# Veilo

> Veilo is an owner-controlled AI agent workspace with delegated spending controls and a shared private funding pool on Solana devnet.

Owners create and configure agents with their own names, jobs, triggers, budgets and approved services. Shawn, Prince and Mira are workflow examples, not a fixed list of agents. The model proposes resources; independent control and wallet services authorize purchases.

The private flow aims to remove the explicit link from a particular deposited note to a payout. Fresh-wallet payments, merchants, amounts and timing remain public. Owners retain local agent attribution; the gateway can link authenticated usage. Do not infer universal anonymity, production readiness, deployed behavior or successful security tests from these documentation pages.

## Product documentation

${pages.map(([file,title,description]) => `- [${title}](./${file === 'index.md' ? '' : file.replace(/\.md$/, '.html')}): ${description}`).join('\n')}

## Complete context

- [Full text](./llms-full.txt): Product documentation and editable diagram definitions in one text file.
`
await writeFile('public/llms.txt', index)
// Compatibility alias for users who request llms.text.
await writeFile('public/llms.text', index)
let full = index + '\n---\n'
for (const [file] of pages) {
  let content = await readFile(file, 'utf8')
  content = content.replace(/<script setup>[\s\S]*?<\/script>\s*/g, '')
    .replace(/<Diagram[^>]*\/>/g, '[Diagram definition included below.]')
  full += `\n${content}\n---\n`
}
for (const name of ['architecture','private-funding','service-delivery','payment']) {
  full += `\n## Diagram: ${name}\n\n\`\`\`mermaid\n${await readFile(`diagrams/${name}.mmd`,'utf8')}\`\`\`\n`
}
await writeFile('public/llms-full.txt', full)
console.log('Generated llms.txt, llms.text and llms-full.txt from product documentation.')
