// app/page.tsx
// Landing route. Sends each visitor to the first page their role can actually
// open: admins to the admin dashboard, juries to their project list, and
// anonymous visitors to the login form. Login redirects here on success, so
// the role → destination decision lives server-side in one place.

import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { homePathForRole } from '@/lib/auth/rbac'

export default async function Home() {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  redirect(homePathForRole(session.user.role))
}
