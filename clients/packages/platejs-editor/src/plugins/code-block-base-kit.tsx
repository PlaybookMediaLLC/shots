import {
  BaseCodeBlockPlugin,
  BaseCodeLinePlugin,
  BaseCodeSyntaxPlugin,
} from "@platejs/code-block";
import { sharedLowlight } from "../lib/lowlight";
import {
  CodeBlockElementStatic,
  CodeLineElementStatic,
  CodeSyntaxLeafStatic,
} from "../ui/code-block-node-static";

export const BaseCodeBlockKit = [
  BaseCodeBlockPlugin.configure({
    node: { component: CodeBlockElementStatic },
    options: { lowlight: sharedLowlight },
  }),
  BaseCodeLinePlugin.withComponent(CodeLineElementStatic),
  BaseCodeSyntaxPlugin.withComponent(CodeSyntaxLeafStatic),
];
