/**
 * Footer — Philips copyright footer displayed at the bottom of every page.
 * Uses marginTop: auto to stick to the bottom of flex containers.
 */

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer style={{
      background: 'linear-gradient(135deg, #0052cc 0%, #003d99 100%)',
      color: 'rgba(255, 255, 255, 0.9)',
      padding: '0.75rem 2rem',
      fontSize: '0.8rem',
      textAlign: 'center',
      marginTop: 'auto',  // Push to bottom in flex layouts
      flexShrink: 0,      // Don't shrink when content is short
    }}>
      © Koninklijke Philips N.V., 2004 - {year}. All rights reserved.
    </footer>
  )
}
