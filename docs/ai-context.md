# Context for AI tools

Use these plain-text files when asking an AI assistant to explain Veilo, plan an integration or reason about its technical boundaries.

| File | Contents |
|---|---|
| [llms.txt](/llms.txt) | Product summary, important boundaries and links to technical pages |
| [llms-full.txt](/llms-full.txt) | Complete product documentation and diagram definitions in one file |
| `llms.text` | An alias of the concise context file |

Copy the text into your assistant, or give it the published file URL if it can read websites. These files contain public product context, not wallet secrets, credentials or private activity.

## Important context

- PRD v3.2 adds a paid specialist-agent marketplace. It is implemented in code on `main`; its devnet acceptance (T17–T23) is incomplete. See [marketplace](./guide/marketplace.md) and [triage](./guide/marketplace-triage.md).
- Execution uses coded credit-manager, research and content roles plus a `custom` role that can propose marketplace hires. The named agents are examples.
- Supabase holds marketplace identity/product records; local control/wallet retain money authority. The local P0 stack works without Supabase.
- Seller payments must be direct, with zero platform fee and receipt-based earnings. Marketplace sign-in cannot authorize spending.
- The model proposes work. Independent services authorize money.
- Private funding targets the explicit deposit-to-withdrawal link; merchant transfers remain public.
- The owner retains agent attribution, and the gateway can link authenticated usage.
- [Current status](./guide/status.md) distinguishes the M2 devnet run, the pre-merge devnet demo run, local fixture workflows and the evidence still missing. Documentation does not certify an audit or imply every acceptance scenario passed.

The context files are regenerated from the technical pages whenever the documentation is built.
