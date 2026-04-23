import { fetchAuthSession } from "aws-amplify/auth";

export async function getIdToken(): Promise<string | undefined> {
  const session = await fetchAuthSession();
  return session.tokens?.idToken?.toString();
}
