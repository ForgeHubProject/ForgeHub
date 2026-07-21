/**
 * Back-compat shim: ConfirmDialog now lives in the ui/ primitives cluster, built
 * on the shared Dialog. Re-exported here so existing `components/ConfirmDialog`
 * imports keep working; new code should import from `../ui`.
 */
export { ConfirmDialog } from "../ui/ConfirmDialog";
