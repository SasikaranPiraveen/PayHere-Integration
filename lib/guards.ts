import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { adminIds } from "@/lib/env";

export async function getUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

/** Admin = user id listed in ADMIN_USER_IDS, or Clerk publicMetadata { "role": "admin" }. */
export async function getAdminId(): Promise<string | null> {
  const userId = await getUserId();
  if (!userId) return null;
  if (adminIds().includes(userId)) return userId;
  const user = await currentUser();
  return user?.publicMetadata?.role === "admin" ? userId : null;
}
