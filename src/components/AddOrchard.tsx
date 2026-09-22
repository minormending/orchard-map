import { useEffect, useRef, useState } from 'react'
import { useEscape } from '@minormending/map-kit'
import { supabase, HAS_DB } from '../lib/db'
import { useAccount } from '../lib/account'
import { FILTERS } from '../lib/filters'
import Button from './ui/Button'
import { locate, type Precision } from '../lib/locate'
import { STATES } from '../lib/states'
import { readWebsite } from '../lib/website'
import { splitAddress, repeatsPlace } from '../lib/address'
import type { Tag } from '../lib/types'

/** How long to wait after the last keystroke before asking the geocoder. */
const SETTLE_MS = 700

/**
 * Propose an orchard that is not here.
 *
 * It lands hidden and goes to the moderation queue. A signed-in stranger
 * cannot put a pin on the map — which is the same door an auto-hidden orchard
 * comes back through, so there is one review path rather than two.
 *
 * The position used to come only from a click on the map, because several of
 * these farms are down an unnamed track where geocoding the address lands you
 * at the wrong end of the county. That is still true of those farms and is why
 * the map click has not gone anywhere. What it got wrong was making everybody
 * else pay for it: somebody who knows the address had to find their own roof
 * on a slippy map to avoid a bad result their address would never have
 * produced.
 *
 * So the address is looked up as it is typed, and the answer is offered rather
 * than imposed. Two rules keep that from becoming the old failure with extra
 * steps: a pin placed by hand is never overwritten by a later lookup, and an
 * address with no house number is submitted as `approximate`, which is what
 * makes the farm's page tell visitors the pin is the road and not the gate.
 */
export function AddOrchard({
  at,
  from,
  precision,
  onPick,
  onGeocoded,
  onClose,
}: {
  at: { lat: number; lng: number } | null
  /** Where the current pin came from. A hand-placed pin outranks the geocoder. */
  from: 'map' | 'address' | null
  precision: Precision
  onPick: () => void
  onGeocoded: (at: { lat: number; lng: number }, precision: Precision) => void
  onClose: () => void
}) {
  const account = useAccount()
  const [name, setName] = useState('')
  const [town, setTown] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [address, setAddress] = useState('')
  const [website, setWebsite] = useState('')
  /* Only ever set by accepting the split below. There is no zip field to
     fill in: nobody should have to type it twice, and typing it once is what
     the address box already was. */
  const [zip, setZip] = useState('')
  const [tags, setTags] = useState<Tag[]>([])
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [problem, setProblem] = useState<string | null>(null)

  const [looking, setLooking] = useState(false)
  const [found, setFound] = useState<
    { at: { lat: number; lng: number }; precision: Precision; label: string } | null
  >(null)
  const [noAddress, setNoAddress] = useState<string | null>(null)

  /*
   * `from` is read through a ref rather than listed as a dependency.
   *
   * Applying a result sets `from` to 'address' in the parent, so depending on
   * it here would re-run this effect, look the same address up again, and set
   * it again — a loop paid for one Photon request at a time. The effect should
   * run when the visitor changes what they typed, and that is all it lists.
   */
  const fromRef = useRef(from)
  fromRef.current = from

  useEscape(onClose)

  useEffect(() => {
    if (!account) return
    if (address.trim().length < 4) {
      setFound(null)
      setNoAddress(null)
      setLooking(false)
      return
    }

    const ac = new AbortController()
    const timer = setTimeout(async () => {
      setLooking(true)
      try {
        const result = await locate({ address, town }, { signal: ac.signal })
        if (ac.signal.aborted) return
        if (result.ok) {
          setNoAddress(null)
          setFound({ at: result.at, precision: result.precision, label: result.label })
          // A pin the visitor placed themselves is theirs; offer, do not take.
          if (fromRef.current !== 'map') onGeocoded(result.at, result.precision)
        } else {
          setFound(null)
          setNoAddress(result.reason)
        }
      } catch {
        if (!ac.signal.aborted) {
          setFound(null)
          setNoAddress('Address lookup is unavailable just now. Place it on the map.')
        }
      } finally {
        if (!ac.signal.aborted) setLooking(false)
      }
    }, SETTLE_MS)

    return () => {
      clearTimeout(timer)
      ac.abort()
    }
  }, [address, town, account])

  if (!HAS_DB) return null

  /*
   * Settled on every keystroke rather than on submit, because the only useful
   * thing to say about a website is what will be stored — and saying it after
   * the form has closed helps nobody.
   *
   * A farm with no website is the ordinary case here and always has been: 85
   * of the 301 rows on the map have none. So an empty box is an answer, and
   * the only thing that stops a submission is a box with something unusable
   * in it.
   */
  const site = readWebsite(website)

  /*
   * A whole address in the street box, and whether it is saying the town
   * twice.
   *
   * `tail` is what could be moved; `said twice` is the narrower thing the
   * database refuses. They are separated because only the second is an error:
   * a tail naming some other town might be part of a street name, and the
   * form offers to move it without insisting.
   */
  const tail = splitAddress(address)
  /* Compared against the fields that will actually be submitted, which is
     what the database compares them against. Passing the parsed town here
     compares it with itself and says "said twice" about every tail. */
  const saidTwice = repeatsPlace(address, town, stateCode)

  /* Moving it is the visitor's decision, taken in one click. Town and state
     are only filled when empty — what they typed themselves outranks what was
     parsed out of another field. */
  const useSplit = () => {
    if (!tail) return
    setAddress(tail.street)
    if (!town.trim()) setTown(tail.town)
    if (!stateCode) setStateCode(tail.state)
    if (tail.zip) setZip(tail.zip)
  }

  const send = async () => {
    if (!at || !stateCode || name.trim().length < 2 || !site.ok || saidTwice) return
    setState('sending')
    setProblem(null)

    const { data, error } = await supabase!.rpc('submit_orchard', {
      p_name: name,
      p_lat: at.lat,
      p_lng: at.lng,
      p_address: address || null,
      p_town: town || null,
      p_state: stateCode,
      p_tags: tags,
      p_precision: precision,
      p_website: site.url,
      p_zip: zip || null,
    })

    if (error) {
      setState('idle')
      setProblem(
        error.code === '53400'
          ? 'That is five for today — thank you, come back tomorrow.'
          : 'That did not go through. Try again shortly.',
      )
      return
    }
    if (data && data.ok === false) {
      setState('idle')
      setProblem(
        data.reason === 'duplicate'
          ? `There is already a pin within 300m — ${data.near}. Is it the same farm?`
          : 'That could not be added.',
      )
      return
    }
    setState('sent')
  }

  return (
    <section className="add" aria-label="Add an orchard">
      <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">×</button>
      <h2>Add an orchard</h2>

      {!account ? (
        <p className="muted">
          Adding a farm needs an account, so there is somebody to ask if a
          listing turns out to be wrong. Reporting what you found does not.
        </p>
      ) : state === 'sent' ? (
        <p className="flag-sent">
          Thank you. It goes to a person before it appears on the map — usually
          within a day or two.
        </p>
      ) : (
        <>
          <label className="add-field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </label>
          <label className="add-field">
            <span>Town</span>
            <input value={town} onChange={(e) => setTown(e.target.value)} maxLength={100} />
          </label>

          {/*
            * Next to the town, because that is the pair the map itself prints
            * under a farm's name, and nothing is chosen for the visitor.
            *
            * A preselected 'NY' would be the old hardcoded value with a
            * dropdown in front of it: right for most submissions, silently
            * wrong for the rest, and skipped by exactly the people whose farm
            * is not in New York. Somebody proposing a farm knows which state
            * it is in, so being asked costs them one click and ends the guess.
            */}
          <label className="add-field">
            <span>State</span>
            <select value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
              <option value="">Choose a state…</option>
              {STATES.map((s) => (
                <option key={s.code} value={s.code}>{s.name}</option>
              ))}
            </select>
          </label>

          <label className="add-field">
            <span>Address</span>
            <input
              value={address}
              onChange={(e) => { setAddress(e.target.value); setZip('') }}
              maxLength={200}
              placeholder="700 Lawlins Rd"
              autoComplete="off"
              aria-invalid={saidTwice}
            />
          </label>

          {/*
            * Offered, not done. The tail could be part of a street name and
            * only the person typing knows — the same bargain the geocoder
            * makes two fields down.
            *
            * When it repeats the town or state being submitted beside it,
            * that judgment is not open: those have columns of their own, the
            * farm's page would print them twice, and the database refuses it.
            * Better to say so here than to send it and report "that did not
            * go through".
            */}
          {tail && (
            <p className="add-split" aria-live="polite">
              {saidTwice ? (
                <span className="add-rough">
                  The town and state have their own boxes below, so this would
                  print them twice.{' '}
                </span>
              ) : (
                <span className="muted">That looks like the whole address. </span>
              )}
              <button type="button" className="link" onClick={useSplit}>
                Keep “{tail.street}” here
              </button>
              <span className="muted">
                {' '}and move {tail.town}, {tail.state}
                {tail.zip ? ` ${tail.zip}` : ''} out.
              </span>
            </p>
          )}

          {/*
            * Asked for, because without it the farm is on the map and mute.
            *
            * Everything the map knows beyond a name and a pin — hours, whether
            * picking is on, what is ripe this week — comes from reading the
            * farm's own site, and the crawler's target list is simply the rows
            * that have one. A submission with this box empty can be published
            * and can never say anything else about itself.
            */}
          <label className="add-field">
            <span>Website</span>
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              maxLength={500}
              placeholder="abmasfarm.com"
              inputMode="url"
              autoComplete="off"
              aria-invalid={!site.ok}
            />
          </label>

          {/*
            * What will actually be stored, whenever that is not what was
            * typed. The scheme is added rather than demanded — nobody writes
            * one on the side of a barn — but it is added in the open, the way
            * the geocoder shows the pin it found, so somebody whose site has
            * no certificate can put `http://` back and be believed.
            */}
          <p className="add-site" aria-live="polite">
            {!site.ok ? (
              <span className="add-rough">{site.reason}</span>
            ) : site.url && site.url !== website.trim() ? (
              <span className="muted">Saved as {site.url}</span>
            ) : null}
          </p>

          <p className="add-where" aria-live="polite">
            {at ? (
              <>Position set: {at.lat.toFixed(4)}, {at.lng.toFixed(4)}. </>
            ) : (
              <>No position yet. </>
            )}
            <button type="button" className="link" onClick={onPick}>
              {at ? 'Pick again on the map' : 'Click the map to place it'}
            </button>
          </p>

          <p className="add-found" aria-live="polite">
            {looking && <span className="muted">Looking up the address…</span>}

            {!looking && noAddress && <span className="muted">{noAddress}</span>}

            {!looking && found && from === 'address' && (
              <span className="muted">From the address: {found.label}.</span>
            )}

            {/*
              * The visitor moved the pin themselves and then edited the
              * address. Both are plausibly right, and neither one of them is
              * ours to pick, so the lookup says what it found and waits.
              */}
            {!looking && found && from === 'map' && (
              <>
                <span className="muted">That address is at {found.label}. </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => onGeocoded(found.at, found.precision)}
                >
                  Use that instead
                </button>
              </>
            )}

            {!looking && at && precision === 'approximate' && (
              <span className="add-rough">
                {' '}That address has no house number, so this pin is the right
                road rather than the front gate. If you know where the entrance
                is, place it on the map instead.
              </span>
            )}
          </p>

          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`chip ${tags.includes(f.key) ? 'chip-on' : ''}`}
                aria-pressed={tags.includes(f.key)}
                onClick={() =>
                  setTags((t) =>
                    t.includes(f.key) ? t.filter((x) => x !== f.key) : [...t, f.key],
                  )
                }
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flag-actions">
            <Button
              disabled={
                !at || !stateCode || name.trim().length < 2 || !site.ok || saidTwice ||
                state === 'sending'
              }
              onClick={send}
            >
              {state === 'sending' ? 'Sending…' : 'Submit for review'}
            </Button>
          </div>
          {problem && <p className="auth-error">{problem}</p>}
        </>
      )}
    </section>
  )
}
