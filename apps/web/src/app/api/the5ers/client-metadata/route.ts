import { handler, ok } from "@/server/api";
import { clientMetadata } from "@/server/the5ers/registration";
export const GET = handler((request: Request) => ok(clientMetadata(new URL(request.url).origin)), {
  public: true,
});
