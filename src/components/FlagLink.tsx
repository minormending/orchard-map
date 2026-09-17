import { useState } from 'react'
import { supabase, HAS_DB } from '../lib/db'
import type { Orchard } from '../lib/types'

/**
 * "Something here is wrong."
 *
 * Goes to a queue a person reads. Nothing it writes changes the map on its
 * own: taking a listing off is a judgment call, and business-removal requests
 * arrive through this same door.
 */
export function FlagLink({ orchard }: { orchard: Orchard }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  if (!HAS_DB) return null

  const send = async () => {
    if (message.trim().length === 0) return
    setState('sending')
    const { error } = await supabase!.rpc('submit_flag', {
      p_target_type: 'orchard',
      p_target_id: orchard.id,
      p_message: message,
      p_contact_email: email || null,
    })
    setState(error ? 'error' : 'sent')
  }

  if (state === 'sent') {
    return <p className="flag-sent">Thank you — somebody will look at it.</p>
  }

  if (!open) {
    return (
      <button type="button" className="link flag-open" onClick={() => setOpen(true)}>
        Something wrong with this listing?
      </button>
    )
  }

  return (
    <div className="flag">
      <label>
        <span className="visually-hidden">What is wrong</span>
        <textarea
          rows={3}
          placeholder="Closed for good, wrong address, this is my farm and I would like it removed…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <label className="flag-email">
        <span>Your email, if you would like an answer</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <div className="flag-actions">
        <button
          type="button"
          className="button"
          disabled={state === 'sending' || message.trim().length === 0}
          onClick={send}
        >
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {state === 'error' && <p className="auth-error">That did not go through. Try again shortly.</p>}
    </div>
  )
}
