import { readFile, writeFile } from 'node:fs/promises'

const pages = [
  ['evidence.md', 'Evidence and submission', 'Public devnet receipts, downloadable presentation and submission checklist.'],
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

Status: Solana devnet development prototype, not audited or suitable for production funds. See the current-status page for implemented capabilities, dated test results and remaining end-to-end checks. The evidence page contains public transaction receipts and submission files.

Veilo combines personal agents, a local private wallet and a specialist marketplace. Supabase holds marketplace identity and product data; local control and wallet services retain spending authority. Spending limits are service-enforced. Groth16 authorizes pool withdrawals; fresh wallets make ordinary x402 merchant payments. Amounts, merchants and timing remain public.

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
