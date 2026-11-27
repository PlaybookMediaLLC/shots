import { common, createLowlight } from "lowlight";

/** Shared lowlight instance using common grammars instead of 190+ `all` grammars. */
export const sharedLowlight = createLowlight(common);
