import type { ReactNode } from 'react'

/**
 * The pill button, wherever it is pressed.
 *
 * One component rather than an Astro one and a React twin, because Astro
 * renders a framework component with no `client:` directive to plain HTML at
 * build time and wraps it in nothing. The 302 orchard pages therefore use this
 * and still ship no JavaScript; the four islands use the same file and
 * hydrate. That is worth having explicitly in a comment, since the obvious
 * assumption — React component, therefore React on the client — is what would
 * otherwise push somebody into writing the second copy.
 *
 * `quiet` is the secondary: same pill, same height, the page's own background.
 * It reads as the same kind of thing as the primary because it *is* — the row
 * under an orchard's name is four ways to act on that farm, and only one of
 * them is the one you probably came for.
 */
export type ButtonVariant = 'primary' | 'quiet'

/** The class vocabulary, in one place, so the two variants cannot drift. */
export function buttonClass(variant: ButtonVariant = 'primary'): string {
  return variant === 'quiet' ? 'button button-quiet' : 'button'
}

type LinkProps = {
  href: string
  target?: string
  rel?: string
  onClick?: never
  disabled?: never
  type?: never
}

type PressProps = {
  href?: never
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}

type Props = {
  variant?: ButtonVariant
  children?: ReactNode
} & (LinkProps | PressProps)

/*
 * An `href` makes it a link and its absence makes it a button, which is the
 * distinction the browser cares about: one navigates and can be opened in a
 * new tab, the other runs a handler. The union keeps the two sets of props
 * from being mixed — a `disabled` link does nothing, and a `target` on a
 * <button> is a no-op that reads like it works.
 */
export default function Button({ variant, children, ...rest }: Props) {
  const className = buttonClass(variant)

  if (rest.href !== undefined) {
    const { href, target, rel } = rest
    return (
      <a className={className} href={href} target={target} rel={rel}>
        {children}
      </a>
    )
  }

  const { onClick, disabled, type = 'button' } = rest
  return (
    <button type={type} className={className} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}
