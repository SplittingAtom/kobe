import { KubeConfig, NodeV1Api } from "@kubernetes/client-node";
import type { RuntimeClassLike } from "./runtime-class.js";

/** Lists cluster RuntimeClasses using the in-cluster ServiceAccount (or local kubeconfig). */
export async function listRuntimeClasses(): Promise<RuntimeClassLike[]> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const list = await kc.makeApiClient(NodeV1Api).listRuntimeClass();
  return list.items;
}
