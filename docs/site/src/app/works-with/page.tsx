import Link from 'next/link';
import { getStars } from '@/kit/stars';
import { Footer, Kit, Nav, Section } from '@/kit/blocks';
import { docUrl, site } from '@/lib/site';

export const metadata = { title: 'Works with: MaiPai Stack', description: 'The apps, engines and hardware MaiPai Stack works with.' };

export default async function Page() {
  const stars = await getStars(site.repo.user, site.repo.repo);
  return (
    <Kit product="stack">
      <Nav site={site} stars={stars} />
      <div className="herobg">
        <div className="wrap pagehead">
          <div className="eyebrow">Works with</div>
          <h1 style={{ maxWidth: 'none' }}>What MaiPai Stack <span className="hl">works with</span>.</h1>
          <p className="lead">Apps that speak the OpenAI format, MaiPai Home, and the engines and hardware Stack runs. We name a third-party app here only after we have tested it.</p>
        </div>
      </div>
      <Section title="Apps and tools">
        <div className="wk">
          <div className="card">
            <b>Apps that speak the OpenAI format</b>
            <p>Stack answers on one local address, 127.0.0.1 port 8770 by default, in the shape existing client libraries use. Chat completions, embeddings, transcription, speech, pictures, video and music each have a standard path. Apps that are not Home can use chat, vision, speech and the model list.</p>
            <ul>
              <li>Reads such as the model list work as is on this computer.</li>
              <li>Make an app key on the admin page and send it as a standard bearer key. Each key is limited to the scopes you tick, can be revoked at once, and waits behind Home's own requests.</li>
              <li>Keys work on this computer only, and do not reach settings, jobs, embeddings or picture routes.</li>
              <li>No third-party app is tested yet, so none is named.</li>
            </ul>
            <em><a href={docUrl('integrations.md')}>Integration contract &rarr;</a></em>
          </div>
          <div className="card">
            <b>MaiPai Home</b>
            <p>The first app built on Stack: profiles with child safety, podcasts, music, films and a robot friend. Home installs the Stack for you, and it can run on a different computer in the same home.</p>
            <em><a href={site.sister.href}>See Home &rarr;</a></em>
          </div>
        </div>
      </Section>
      <Section alt title="Engines">
        <p className="sub">Stack starts and watches these for you, so an app asks for a job, not a program. Swapping one never changes the address your apps use.</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Job</th><th>Engines</th></tr></thead>
            <tbody>
              <tr><td>Chat and coding</td><td>llama-server by default; mlx-serve or oMLX as options</td></tr>
              <tr><td>Speech in and out</td><td>sherpa-onnx, Pocket TTS</td></tr>
              <tr><td>Pictures</td><td>ComfyUI, and a native picture worker on a Mac</td></tr>
              <tr><td>Video, music and more</td><td>One-shot engines Stack runs on demand</td></tr>
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ marginTop: 14 }}>The full list, with the pinned build of each, is in the <a href={docUrl('components.md')} style={{ textDecoration: 'underline' }}>generated components page</a>.</p>
      </Section>
      <Section title="Hardware">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Platform</th><th>Status</th></tr></thead>
            <tbody>
              <tr><td>macOS, Apple silicon</td><td><span className="badge b-ok">Tested</span></td></tr>
              <tr><td>Linux</td><td><span className="badge b-pre">Built, not tested yet</span></td></tr>
              <tr><td>Windows</td><td><span className="badge b-plan">Not supported</span></td></tr>
            </tbody>
          </table>
        </div>
        <p className="sub" style={{ marginTop: 14 }}>Ready-made setups cover 16, 32, 64 and 128 GB of memory and up. <Link href="/features/memory" style={{ textDecoration: 'underline' }}>Read about Memory and tiers</Link>.</p>
      </Section>
      <Footer site={site} />
    </Kit>
  );
}
