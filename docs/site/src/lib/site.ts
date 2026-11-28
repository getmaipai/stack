import features from '../../features.json';
import type { Area, SiteConfig } from '@/kit/types';

const DOCS = 'https://github.com/getmaipai/stack/blob/main/docs';

export const site: SiteConfig = {
  product: 'stack',
  name: 'MaiPai Stack',
  repo: { user: 'getmaipai', repo: 'stack' },
  logo: { light: '/brand/maipai-stack-logo-light.png', dark: '/brand/maipai-stack-logo-dark.png' },
  sister: { name: 'Home', href: 'https://github.com/getmaipai/home' },
  extraLinks: [{ text: 'Works with', href: '/works-with' }],
  docsHref: `${DOCS}/user/index.md`,
  featuresHref: '/features',
  getStartedHref: `${DOCS}/user/install.md`,
  sponsorHref: 'https://github.com/sponsors/getmaipai',
  privacyHref: `${DOCS}/user/privacy.md`,
};

export const docUrl = (doc: string) => `${DOCS}/${doc}`;
export const featuresBase = '/features';
export const areas: Area[] = features.areas.map((a) => ({ slug: a.slug, title: a.name, line: a.card, icon: a.icon }));
export { features };
