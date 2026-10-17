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
      { text: 'Design', link: '/guide/architecture' },
      { text: 'Security', link: '/security/assessment' },
      { text: 'AI context', link: '/ai-context' }
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Overview', link: '/' },
        { text: 'Agent workflows', link: '/guide/agents' },
        { text: 'Context for AI tools', link: '/ai-context' }
      ] },
      { text: 'Technical design', items: [
        { text: 'Architecture', link: '/guide/architecture' },
        { text: 'Payment lifecycle', link: '/guide/payments' },
        { text: 'Policy & accounting', link: '/guide/policy' },
        { text: 'Privacy & trust', link: '/guide/privacy' },
        { text: 'Deployment & configuration', link: '/guide/running' }
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
