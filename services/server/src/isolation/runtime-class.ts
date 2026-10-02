/**
 * Isolation prerequisite (spec D4, principle 7): Kobe refuses to run agents without a gVisor or
 * Kata RuntimeClass. Judged by the RuntimeClass handler, never its name. There is no bypass.
 */
// Kata handlers carry the hypervisor and options as dash-separated parts (kata-qemu-snp, kata-clh-tdx).
// The chart's _isolation.tpl uses the same pattern (a chart test checks it).
export const ISOLATION_HANDLER = /^(runsc|kata(-[a-z0-9]+)*)$/;

export const ISOLATION_REMEDIATION = [
  "Kobe refuses to run agents without an isolation runtime: no RuntimeClass with a gVisor",
  "(handler 'runsc') or Kata ('kata*') handler exists in this cluster.",
  "Fix: install gVisor on every node with scripts/install-gvisor-k3s.sh (creates RuntimeClass",
  "'gvisor', handler 'runsc'), or install Kata Containers, then retry. See docs/install.md#isolation.",
].join(" ");

export interface RuntimeClassLike {
  readonly metadata?: { readonly name?: string };
  readonly handler: string;
}

export interface IsolationRuntimeClass {
  readonly name: string;
  readonly handler: string;
}

export type IsolationCheck =
  | { readonly ok: true; readonly runtimeClasses: readonly IsolationRuntimeClass[] }
  | { readonly ok: false; readonly message: string };

export function isIsolationHandler(handler: string): boolean {
  return ISOLATION_HANDLER.test(handler);
}

export function findIsolationRuntimeClasses(
  items: readonly RuntimeClassLike[],
): IsolationRuntimeClass[] {
  return items
    .filter((rc) => isIsolationHandler(rc.handler))
    .map((rc) => ({ name: rc.metadata?.name ?? "", handler: rc.handler }));
}

/**
 * Lists RuntimeClasses via `list` and reports whether agents may run. With `runtimeClassName`
 * (the class sandboxes will actually use) that class must exist and have an isolation handler;
 * another isolating class elsewhere in the cluster is not enough. Errors fail closed.
 */
export async function checkIsolation(
  list: () => Promise<readonly RuntimeClassLike[]>,
  runtimeClassName?: string,
): Promise<IsolationCheck> {
  let items: readonly RuntimeClassLike[];
  try {
    items = await list();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `${ISOLATION_REMEDIATION} (could not list RuntimeClasses: ${reason})`,
    };
  }
  if (runtimeClassName !== undefined) {
    const configured = items.find((rc) => rc.metadata?.name === runtimeClassName);
    if (!configured) {
      return {
        ok: false,
        message: `RuntimeClass "${runtimeClassName}" does not exist. ${ISOLATION_REMEDIATION}`,
      };
    }
    if (!isIsolationHandler(configured.handler)) {
      return {
        ok: false,
        message: `RuntimeClass "${runtimeClassName}" has handler "${configured.handler}", which is not gVisor (runsc) or Kata (kata*). ${ISOLATION_REMEDIATION}`,
      };
    }
    return { ok: true, runtimeClasses: [{ name: runtimeClassName, handler: configured.handler }] };
  }
  const runtimeClasses = findIsolationRuntimeClasses(items);
  return runtimeClasses.length > 0
    ? { ok: true, runtimeClasses }
    : { ok: false, message: ISOLATION_REMEDIATION };
}
