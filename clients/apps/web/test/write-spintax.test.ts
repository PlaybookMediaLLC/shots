import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeSpintax, expandSpintax, SpintaxError } from '@/lib/write/spintax'

const source = '{Alpha|Beta|Gamma} technical test {one|two}'

test('a source reports its variations and longest expansion', () => {
  const { longest, variations } = analyzeSpintax(source)
  assert.equal(variations, 6)
  assert.equal(longest, 'Alpha technical test one')
  assert.equal(longest.length, 24)
})

test('each expansion takes one alternative of each group, and may repeat', () => {
  assert.equal(
    expandSpintax(source, () => 0),
    'Alpha technical test one'
  )
  assert.equal(
    expandSpintax(source, () => 0.99),
    'Gamma technical test two'
  )
  const rolls = [0.4, 0.6, 0.4, 0.6]
  const roll = () => rolls.shift()!
  assert.equal(expandSpintax(source, roll), expandSpintax(source, roll))
})

test('the longest expansion follows the measure it is given', () => {
  const heavyB = (text: string) => [...text].reduce((sum, char) => sum + (char === 'b' ? 10 : 1), 0)
  assert.equal(analyzeSpintax('{aaa|b}', heavyB).longest, 'b')
})

test('braces without alternatives stay literal, and a backslash escapes', () => {
  for (const literal of ['Hello {name}', 'open { only', 'close } only', 'no groups'])
    assert.deepEqual([analyzeSpintax(literal).variations, expandSpintax(literal)], [1, literal])
  assert.equal(expandSpintax('\\{a|b\\} and \\\\'), '{a|b} and \\')
  assert.equal(
    expandSpintax('{a\\|b|c}', () => 0),
    'a|b'
  )
  assert.equal(
    expandSpintax('{{a|b}}', () => 0),
    '{a}'
  )
  assert.equal(
    expandSpintax('{|x}', () => 0),
    ''
  )
})

test('nested groups are refused rather than guessed', () => {
  assert.throws(() => analyzeSpintax('{a|{b|c}}'), SpintaxError)
  assert.throws(() => expandSpintax('{a|{b|c}}'), SpintaxError)
})
