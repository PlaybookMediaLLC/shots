import { KEYS, type Value } from '@shots/platejs-editor/platejs'
import { POST_BREAK } from './serialize'

/** The draft for a document export: each post break after the first becomes a horizontal rule. */
export function threadAsRules(value: Value): Value {
  return value.flatMap((node, index) =>
    node.type !== POST_BREAK
      ? [node]
      : index === 0
        ? []
        : [{ children: [{ text: '' }], type: KEYS.hr }]
  )
}
