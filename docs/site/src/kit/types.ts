export type SiteConfig = {
  product: 'home' | 'stack';
  name: string; // "MaiPai Home"
  repo: { user: string; repo: string };
  logo: { light: string; dark: string }; // public paths, no base path
  sister: { name: string; href: string };
  extraLinks?: { text: string; href: string }[]; // extra nav links after Docs
  docsHref: string;
  featuresHref: string;
  getStartedHref: string;
  sponsorHref: string;
  privacyHref: string;
};
export type Area = { slug: string; title: string; line: string; icon: string };
