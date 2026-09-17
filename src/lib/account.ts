import { useEffect, useState } from 'react'
import type { Account } from '@minormending/map-kit'
import { auth, HAS_DB } from './db'

/** The signed-in account, or null. Null is the normal case. */
export function useAccount(): Account | null {
  const [account, setAccount] = useState<Account | null>(null)

  useEffect(() => {
    if (!HAS_DB) return
    let live = true
    auth.current().then((a) => { if (live) setAccount(a) })
    const off = auth.onChange(setAccount)
    return () => { live = false; off() }
  }, [])

  return account
}
