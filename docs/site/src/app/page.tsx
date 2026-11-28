import Link from 'next/link';
import { getStars } from '@/kit/stars';
import { Banner, Footer, InfoCards, Kit, Nav, Section, Sponsors, Stats } from '@/kit/blocks';
import { CodeSample, Frame, ILLUS, Pic } from '@/components/visuals';
import { docUrl, features, site } from '@/lib/site';

export const metadata = {
  title: 'MaiPai Stack: local AI without the homework',
  description: 'The foundation for local AI, at any size. Easy to set up, matched to your hardware, simple to keep running.',
};

const questions: [string, string, string, string][] = [
  ['I only want simple chat. Why do I need this?', 'memory', 'Chat still needs memory care', 'Stack handles memory, restarts and ready-made settings, even for one model.'],
  ['Which models should I even use?', 'setup', 'Pick your computer’s memory size', 'Stack suggests a setup that fits your hardware.'],
  ['How do I install and run them?', 'setup', 'One install, one admin page', 'Engines and models are checked, installed and started.'],
  ['How do I tune them?', 'memory', 'Ready-made setups for 16, 32, 64 or 128 GB and up', 'Sensible settings from the first minute.'],
  ['How do I stop them crashing my computer?', 'memory', 'A memory guard with a priority order', 'Only what fits is loaded, and the work you need most stays loaded.'],
  ['How do I run one without slowing another?', 'queue', 'Chat stays loaded, heavy jobs wait in line', 'Pictures, video and music queue up or are refused with a reason.'],
  ['Full power for one task, lighter for the rest?', 'memory', 'Four levels per feature', 'Reduced, Standard, Boost and Max, each with the model you choose.'],
  ['Where are the logs, and why did it break?', 'health', 'Health and engine logs together', 'Plain words and one fix button.'],
  ['Can I just ask how my setup works?', 'helper', 'A built-in Helper', 'It asks before it changes anything.'],
  ['How do I connect my other apps?', 'connect', 'One local address per job', 'Point any app that speaks the OpenAI format at it.'],
  ['How do I keep it updated, safely?', 'updates', 'Updates you can undo', 'Go back if an engine misbehaves.'],
];

export default async function Page() {
  const stars = await getStars(site.repo.user, site.repo.repo);
  return (
    <Kit product="stack">
      <Nav site={site} stars={stars} />
      <Banner>
        <b>Pre-1.0:</b> MaiPai Home runs on Stack every day. No Stack release is published yet, so install it with a release you build yourself, or with Home.{' '}
        <a href={docUrl('user/install.md')}>Read the install guide</a>
      </Banner>
      <div className="herobg">
        <div className="wrap h2c">
          <div className="stack-hero-l">
            <div className="eyebrow">The foundation for local AI, at any size</div>
            <h1>Local AI without the <span className="hl">homework</span>.</h1>
            <p className="lead">
              Easy to set up, matched to your hardware, simple to keep running. One user or many, one model or many, Stack picks the engine for each job, keeps everything inside your memory and tells you in plain words when something needs help.
            </p>
            <p className="small">Open source, AGPL-3.0. Runs on macOS with Apple silicon. Linux is built but not tested yet.</p>
            <div className="cta">
              <a className="btn pri" href={site.getStartedHref}>Install Stack</a>
              <Link className="btn" href={site.featuresHref}>What it takes care of</Link>
            </div>
            <div className="dl">
              <span className="badge b-ok">macOS, Apple silicon</span>
              <span className="badge b-plan">Runs alone or with Home</span>
            </div>
          </div>
          <div className="stack-hero-r">
            <Frame caption="The admin page Overview: memory, what is running, and what needs attention.">
              <Pic shot="overview" alt="The Stack admin page Overview: a memory gauge, processor and request cards, and one card per feature showing which model answers." crop />
            </Frame>
          </div>
        </div>
      </div>
      <div className="wrap">
        <div className="needs">
          <b>Want a ready-made family app?</b> MaiPai Home is the first app built on Stack, with profiles, podcasts, music, films and a robot friend.{' '}
          <a href={site.sister.href}>See Home &rarr;</a>
        </div>
        <Stats items={[
          { value: '1', label: 'local address for every job' },
          { value: '4', label: 'ready-made setups, 16 to 128 GB and up' },
          { value: '4', label: 'levels per feature, Reduced to Max' },
          { value: '1', label: 'fix button per problem' },
        ]} />
      </div>
      <Section alt eyebrow="Why Stack" title="The same Stack, whatever your size." sub="Local AI breaks the same ways for everyone: it runs out of memory, one job stalls another, and nobody can tell why. Stack handles that once, for one person or many, one model or many.">
        <InfoCards items={[
          { title: 'One person or the whole household', text: 'Chat stays loaded while heavy jobs wait in line, so one request does not stall the rest.', tag: 'One person or many' },
          { title: 'One model or many', text: 'Only what you turn on is loaded. A feature that is off uses no memory.', tag: 'Chat only, or everything' },
          { title: 'Simple chat or heavy video', text: 'Chat stays loaded while a film is made.', tag: 'Light or demanding' },
          { title: 'One computer or two', text: 'Home can run on a different computer from the Stack, over a private link inside your home.', tag: 'Same home network' },
          { title: 'Set up once', text: 'Ready-made setups match your computer’s memory. No tuning homework.', tag: '16 to 128 GB and up' },
          { title: 'Kept healthy', text: 'Problems in plain words, one fix button, and updates you can undo.', tag: 'Health, logs and a Helper' },
        ]} />
      </Section>
      <section>
        <div className="wrap">
          <div className="h2c" style={{ paddingBlock: 0 }}>
            <div>
              <div className="eyebrow">Bring your own front end</div>
              <h2>Speaks the OpenAI format.</h2>
              <p className="sub">
                Stack answers on one local address in the shape existing client libraries already use, so an app built for that format can point at it. An app key made on the admin page works as a standard bearer key on the chat, vision, speech and model-list routes. The routes are listed in the <a href={docUrl('integrations.md')} style={{ textDecoration: 'underline' }}>integration contract</a>.
              </p>
              <Link className="btn" href="/features/connect">Read about Connect your apps &rarr;</Link>
            </div>
            <Frame caption={ILLUS}><CodeSample /></Frame>
          </div>
        </div>
      </section>
      <section className="alt-bg">
        <div className="wrap">
          <div className="eyebrow">Get started</div>
          <h2>Start in three steps.</h2>
          <p className="sub">About 15 minutes on a Mac with Apple silicon.</p>
          <div className="cards">
            <a className="card" href={docUrl('user/install.md')}><b>1. Install</b><p>One script, checked before anything is unpacked.</p><em>docs/user/install &rarr;</em></a>
            <a className="card" href={docUrl('user/sign-in.md')}><b>2. Sign in</b><p>Set the admin password with a one-time code.</p><em>docs/user/sign-in &rarr;</em></a>
            <a className="card" href={docUrl('user/features-and-models.md')}><b>3. Turn on what you need</b><p>Chat, voice, pictures, video, music.</p><em>docs/user/features-and-models &rarr;</em></a>
          </div>
        </div>
      </section>
      <section>
        <div className="wrap">
          <h2>Everything we wished we knew at the start.</h2>
          <p className="sub">The questions every newcomer hits, and what Stack does about each one.</p>
          <div className="qa">
            {questions.map(([q, slug, title, text]) => (
              <Link className="row" href={`/features/${slug}`} key={q}>
                <span className="q">&ldquo;{q}&rdquo;</span>
                <div className="a"><b>{title}</b><span>{text}</span></div>
              </Link>
            ))}
          </div>
          <p style={{ marginTop: 22 }}><Link className="btn" href={site.featuresHref}>See all {features.areas.length} features &rarr;</Link></p>
        </div>
      </section>
      <section className="alt-bg">
        <div className="wrap">
          <div className="h2c" style={{ paddingBlock: 0 }}>
            <div>
              <div className="eyebrow">One example</div>
              <h2>Home is the first app built on Stack.</h2>
              <p className="sub">Add MaiPai Home for chat, voice, pictures, video, music, podcasts, profiles with child safety, and a robot friend. One foundation, a family app on top.</p>
              <a className="btn" href={site.sister.href}>Explore MaiPai Home &rarr;</a>
            </div>
            <Frame caption={ILLUS}>
              <div className="podui">
                {[['Chat, voice and pictures', 'Every part is optional'], ['Profiles with child safety', 'For just you, or the whole household'], ['Podcasts, music and films', 'Your own library'], ['A robot friend', 'Pairs with the hub']].map(([a, b]) => (
                  <div className="ep" key={a}><div><b>{a}</b><small>{b}</small></div></div>
                ))}
              </div>
            </Frame>
          </div>
        </div>
      </section>
      <Sponsors />
      <Footer site={site} />
    </Kit>
  );
}
