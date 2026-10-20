import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { withObservability } from "@/lib/observability";

const handler = withObservability(NextAuth(authOptions), '/api/auth/[...nextauth]');
export { handler as GET, handler as POST };
