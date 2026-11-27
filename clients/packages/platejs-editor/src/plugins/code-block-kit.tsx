"use client";

import { CodeBlockRules } from "@platejs/code-block";
import {
  CodeBlockPlugin,
  CodeLinePlugin,
  CodeSyntaxPlugin,
} from "@platejs/code-block/react";
import { sharedLowlight } from "../lib/lowlight";
import {
  CodeBlockElement,
  CodeLineElement,
  CodeSyntaxLeaf,
} from "../ui/code-block-node";

export const CodeBlockKit = [
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: "match" })],
    node: { component: CodeBlockElement },
    options: { lowlight: sharedLowlight },
    shortcuts: { toggle: { keys: "mod+alt+8" } },
  }),
  CodeLinePlugin.withComponent(CodeLineElement),
  CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),
];
