import { readFile, writeFile } from 'node:fs/promises'

const pages = [
  ['submission-review-2026-10-19.md', 'Submission review', 'Checklist coverage, evidence-export corrections, current test results and remaining operator gates.'],
  ['guide/marketplace.md', 'Specialist-agent marketplace', 'v3.2 buyer/seller marketplace, Supabase boundary, direct payments and zero fee; implemented, devnet acceptance incomplete.'],
  ['guide/marketplace-triage.md', 'Marketplace triage', 'T17–T23 gates and all fourteen acceptance checks mapped to recorded RLS, unit and devnet evidence.'],
  ['guide/status.md', 'Current status', 'Merged-tree checks, M2 and pre-merge demo devnet evidence, local validator/mock workflows and outstanding runs.'],
  ['guide/demo.md', 'Eight-step demo', 'Operator commands, the recorded devnet run and pending browser-wallet screenshots.'],
  ['handoff.md', 'Handoff gaps', 'Outstanding evidence, merged branches, owner decisions and known documentation inconsistencies.'],
  ['references/attribution.md', 'Attribution', 'Direct dependency licenses and unresolved review decisions.'],
  ['index.md', 'Overview', 'Product purpose, owner-created agents, user flow and benefits.'],
  ['guide/agents.md', 'Agent workflows', 'Custom agents and example research, credit and content workflows.'],
  ['guide/architecture.md', 'Architecture', 'Planning, policy, wallet, pool, settlement and service boundaries.'],
  ['guide/payments.md', 'Payment lifecycle', 'Private funding, exact x402 payments, credits and reconciliation.'],
  ['guide/policy.md', 'Policy and accounting', 'Permission tiers, atomic reservations, caps and revocation.'],
  ['guide/privacy.md', 'Privacy and trust', 'Deposit linkage privacy, public metadata and off-chain visibility.'],
  ['guide/running.md', 'Running Veilo', 'Application setup, dashboard routes and roles, marketplace setup, proof builds, backup and documentation builds.'],
  ['security/assessment.md', 'Security model', 'Authority separation, authentication and secret isolation.'],
  ['security/risks.md', 'Trust and risk boundaries', 'Residual risks, assumptions and design responses.'],
  ['security/evidence.md', 'Verification requirements', 'Acceptance scenarios and narrowly mapped recorded local/devnet evidence.']
]

const index = `# Veilo

> Veilo is an owner-controlled AI agent workspace with delegated spending controls and a shared private funding pool on Solana devnet.

Status: the recorded M2 pool/PayAI Echo run and one complete Shawn/Prince/Mira demo run with live inference (2026-10-17-1eba868c, recorded before PR #3 merged) are verified on devnet. Integrated flows are verified on local test validator with a fixture / mock provider. A fresh post-merge devnet run, browser-wallet signing and a private-pool-funded marketplace hire are not yet run. Amounts are USDC on Solana devnet. The deterministic development setup has derivable toxic waste and is for devnet funds only.

Veilo includes a marketplace of reviewed paid specialists: searchable listings, seller review, private jobs/deliverables, direct seller x402 settlement, zero platform fee and receipt-based earnings. Supabase holds marketplace identity/product records; local control/wallet retain spending authority. Cloud sign-in cannot authorize money, and the local P0 stack still works without Supabase. These capabilities are implemented in code and pass live RLS checks; their devnet acceptance is incomplete.

Execution uses credit-manager, research, content and custom roles; custom agents can propose marketplace hires that the owner approves locally. Owners configure names, jobs, triggers, budgets and approved services. Shawn, Prince and Mira are workflow examples, not a fixed list of agents. The model proposes resources; independent control and wallet services authorize purchases.

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
