import { readFile, writeFile } from 'node:fs/promises'

const pages = [
  ['guide/marketplace.md', 'Specialist-agent marketplace', 'Accepted v3.2 buyer/seller scope, Supabase boundary, direct payments and zero fee; pending implementation.'],
  ['guide/marketplace-triage.md', 'Marketplace triage', 'Source-based gaps, T17–T23 and all fourteen acceptance checks; no marketplace pass claimed.'],
  ['guide/status.md', 'Current status', 'M2 devnet evidence, local validator/mock workflows and the pending live gate.'],
  ['guide/demo.md', 'Eight-step demo', 'Operator commands, expected artifacts and explicit pending hashes/screenshots.'],
  ['handoff.md', 'Handoff gaps', 'Owner decisions, publication boundaries and issues in deployment-owned files.'],
  ['references/attribution.md', 'Attribution', 'Pinned architectural reference, direct reuse and unresolved license decisions.'],
  ['index.md', 'Overview', 'Product purpose, owner-created agents, user flow and benefits.'],
  ['guide/agents.md', 'Agent workflows', 'Custom agents and example research, credit and content workflows.'],
  ['guide/architecture.md', 'Architecture', 'Planning, policy, wallet, pool, settlement and service boundaries.'],
  ['guide/payments.md', 'Payment lifecycle', 'Private funding, exact x402 payments, credits and reconciliation.'],
  ['guide/policy.md', 'Policy and accounting', 'Permission tiers, atomic reservations, caps and revocation.'],
  ['guide/privacy.md', 'Privacy and trust', 'Deposit linkage privacy, public metadata and off-chain visibility.'],
  ['guide/running.md', 'Running Veilo', 'Application setup, proof builds, rehearsal, backup and documentation builds.'],
  ['security/assessment.md', 'Security model', 'Authority separation, authentication and secret isolation.'],
  ['security/risks.md', 'Trust and risk boundaries', 'Residual risks, assumptions and design responses.'],
  ['security/evidence.md', 'Verification requirements', 'Acceptance scenarios and narrowly mapped recorded local/devnet evidence.']
]

const index = `# Veilo

> Veilo is an owner-controlled AI agent workspace with delegated spending controls and a shared private funding pool on Solana devnet.

Status: the recorded M2 pool/PayAI Echo run is verified on devnet. Integrated flows are verified on local test validator with a fixture / mock provider. A parallel branch records a later devnet gateway execution, but complete task/live-inference acceptance evidence is missing here. Marketplace acceptance is not yet run in this checkout. The deterministic development setup has derivable toxic waste and is for test funds only.

PRD v3.2 accepts a marketplace of reviewed paid specialists: searchable listings, seller review, private jobs/deliverables, direct seller x402 settlement, zero platform fee and receipt-based earnings. Supabase holds marketplace identity/product records; local control/wallet retain spending authority. Cloud sign-in cannot authorize money, and the local P0 stack still works without Supabase. These marketplace capabilities are pending, not shipped.

Existing execution uses credit-manager, research and content roles; generic templates are a T19 requirement. Owners configure names, jobs, triggers, budgets and approved services. Shawn, Prince and Mira are workflow examples, not a fixed list of agents. The model proposes resources; independent control and wallet services authorize purchases.

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
for (const name of ['architecture','private-funding','service-delivery','payment','marketplace']) {
  full += `\n## Diagram: ${name}\n\n\`\`\`mermaid\n${await readFile(`diagrams/${name}.mmd`,'utf8')}\`\`\`\n`
}
await writeFile('public/llms-full.txt', full)
console.log('Generated llms.txt, llms.text and llms-full.txt from product documentation.')
