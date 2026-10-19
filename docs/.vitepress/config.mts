import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Veilo',
  description: 'Technical documentation for owner-controlled agents, spending policy and private funding.',
  base: process.env.DOCS_BASE || '/Veilo-agent-wallet/',
  lang: 'en-US',
  lastUpdated: false,
  ignoreDeadLinks: false,
  themeConfig: {
    siteTitle: 'Veilo / Docs',
    nav: [
      { text: 'Marketplace', link: '/guide/marketplace' },
      { text: 'Design', link: '/guide/architecture' },
      { text: 'Security', link: '/security/assessment' },
      { text: 'Evidence', link: '/evidence' },
      { text: 'AI context', link: '/ai-context' }
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Overview', link: '/' },
        { text: 'Current status', link: '/guide/status' },
        { text: 'Evidence & submission', link: '/evidence' },
        { text: 'Running Veilo', link: '/guide/running' },
        { text: 'Demo script', link: '/guide/demo' },
        { text: 'Handoff gaps', link: '/handoff' },
        { text: 'Agent workflows', link: '/guide/agents' },
        { text: 'Context for AI tools', link: '/ai-context' }
      ] },
      { text: 'Marketplace', items: [
        { text: 'Specialist marketplace', link: '/guide/marketplace' },
        { text: 'Verification status', link: '/guide/marketplace-triage' }
      ] },
      { text: 'Technical design', items: [
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Payment lifecycle', link: '/guide/payments' },
        { text: 'Policy & accounting', link: '/guide/policy' },
        { text: 'Privacy & trust', link: '/guide/privacy' },
        { text: 'Protocol reference', link: '/protocol' },
        { text: 'Deployment runbook', link: '/deployment' },
        { text: 'Configuration reference', link: '/configuration' }
      ] },
      { text: 'Reference archive', items: [
        { text: 'Architecture reference', link: '/architecture' },
        { text: 'Security reference', link: '/security' },
        { text: 'Source attribution', link: '/references/attribution' }
      ] },
      { text: 'Security', items: [
        { text: 'Security model', link: '/security/assessment' },
        { text: 'Verification requirements', link: '/security/evidence' },
        { text: 'Trust & risk boundaries', link: '/security/risks' }
      ] }
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/Seann004/Veilo-agent-wallet' }],
    editLink: {
      pattern: 'https://github.com/Seann004/Veilo-agent-wallet/edit/main/docs/:path',
      text: 'Edit this page'
    },
    footer: { message: 'Veilo technical documentation · Solana devnet' }
  }
})
