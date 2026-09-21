import { useEffect, useState } from 'react'
import type { Account } from '@minormending/map-kit'
import { supabase, HAS_DB } from './db'
import type { OrchardStatus } from './types'

/**
 * What happened to the farms you proposed.
 *
 * The submission form promises "it goes to a person before it appears on the
 * map — usually within a day or two", and until now that was the last thing a
 * submitter ever heard. The row lands hidden, `orchards_read` was
 * `status = 'active'`, and so the one person with a stake in it was the one
 * person who could not see it. Abma's Farm Market sat hidden for four hours on
 * 21 September and its submitter could not have told the difference between
 * that and being thrown away.
 *
 * Migration 021 widens the policy to "active, or yours", which is what makes
 * this query return anything at all.
 *
 * ---------------------------------------------------------------------------
 * What this deliberately does not claim
 * ---------------------------------------------------------------------------
 *
 * `hidden` is where a submission waits AND where a moderator puts a farm they
 * decided against. The difference lives in whether the `submission` flag has
 * been resolved, and `flags` is revoked from clients outright — "no grant on
 * the table is a stronger answer than a policy that returns zero rows", as the
 * grants migration puts it, and widening that to tell somebody their farm was
 * declined is not a trade worth making for a status line.
 *
 * So the UI says what is true of both — it is not on the map — and prints the
 * date it was submitted, which is the fact somebody needs to decide whether
 * enough time has passed to ask. Inventing "still being reviewed" for a farm
 * that was quietly declined would be the same species of lie as a stale
 * "picking is open".
 */
export interface Submission {
  slug: string
  name: string
  town: string | null
  state: string | null
  status: OrchardStatus
  created_at: string
}

export type SubmissionState = 'idle' | 'loading' | 'ready' | 'failed'

export function useMySubmissions(account: Account | null): {
  rows: Submission[]
  state: SubmissionState
} {
  const [rows, setRows] = useState<Submission[]>([])
  const [state, setState] = useState<SubmissionState>('idle')

  useEffect(() => {
    if (!HAS_DB || !account) {
      setRows([])
      setState('idle')
      return
    }
    let live = true
    setState('loading')

    supabase!
      .from('orchards')
      .select('slug, name, town, state, status, created_at')
      .eq('created_by', account.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (!live) return
        if (error) {
          setState('failed')
          return
        }
        setRows((data ?? []) as Submission[])
        setState('ready')
      })

    return () => { live = false }
  }, [account])

  return { rows, state }
}

/**
 * How to describe a submission's state to the person who made it.
 *
 * Three statuses, three sentences, none of which promises an outcome. See the
 * note above on why `hidden` does not say "being reviewed".
 */
export function submissionState(status: OrchardStatus): string {
  if (status === 'active') return 'On the map'
  if (status === 'removed') return 'Taken off the map'
  return 'Not on the map'
}
