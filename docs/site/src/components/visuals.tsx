import { withBase } from '@/kit/base';

/** A real admin screenshot, light and dark pair. CSS shows the one that matches the theme. */
export function Pic({ shot, alt, crop }: { shot: string; alt: string; crop?: boolean }) {
  const cls = `pic${crop ? ' crop' : ''}`;
  return (
    <>
      <img className={`${cls} pic-l`} src={withBase(`/screens/${shot}-desktop-light.webp`)} alt={alt} loading="lazy" />
      <img className={`${cls} pic-d`} src={withBase(`/screens/${shot}-desktop-dark.webp`)} alt={alt} loading="lazy" />
    </>
  );
}

export function Frame({ children, caption, label }: { children: React.ReactNode; caption: string; label?: string }) {
  return (
    <figure className="shot" style={{ margin: 0 }} aria-label={label}>
      <div className="bar" aria-hidden><i /><i /><i /></div>
      {children}
      <figcaption className="cap">{caption}</figcaption>
    </figure>
  );
}

const ILLUS = 'Illustration, not a real screen.';

/** The drawn illustrations: labeled as such until they match a real screen. */
export function Lanes() {
  const lanes: [string, [string, string?][]][] = [
    ['Chat', [['Reply'], ['Reply']]],
    ['Voice', [['Speak']]],
    ['Pictures', [['Image', 'm'], ['Next', 'w']]],
    ['Video and music', [['Film clip', 'm'], ['Waiting', 'w']]],
  ];
  return (
    <div className="lanes">
      {lanes.map(([name, jobs]) => (
        <div className="lane" key={name}>
          <span>{name}</span>
          <div className="track">
            {jobs.map(([t, k], i) => <span className={`job${k ? ' ' + k : ''}`} key={i}>{t}</span>)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CodeSample() {
  return (
    <div className="podui">
      <pre className="codebox"><span>$</span> curl http://127.0.0.1:8770/v1/models{'\n'}{'\n'}chat, coding, judge, embed, stt, tts, ...</pre>
      <pre className="codebox">x-maipai-engine: local b12589-6f5c9ad21{'\n'}x-maipai-model: the model file that answered</pre>
    </div>
  );
}

export function HealthIllus() {
  return (
    <div className="health" style={{ padding: 18 }}>
      <div className="hrow"><span>Pictures engine stopped</span><span className="btn pri" style={{ padding: '4px 12px' }}>Restart</span></div>
      <div className="hrow"><span>Update available: voice engine</span><span className="btn" style={{ padding: '4px 12px' }}>Update</span></div>
      <div className="hrow"><span>All other checks pass</span><span className="badge b-ok">Healthy</span></div>
    </div>
  );
}

export { ILLUS };
