import assert from 'node:assert/strict'
import test from 'node:test'
import { groupFiles, isInFolder, storedFileName } from '@/lib/write/bulk-intake'

const image = (path: string, size = 10, type = 'image/png') => ({
  name: path.split('/').pop()!,
  size,
  type,
  webkitRelativePath: path,
})

test('a folder of images is one post, in natural order', () => {
  const { posts, skipped } = groupFiles(
    [image('Trip/10.png'), image('Trip/2.png'), image('Trip/1.png')],
    'folder'
  )
  assert.equal(posts.length, 1)
  assert.equal(posts[0]?.sourceKey, 'Trip')
  assert.deepEqual(
    posts[0]?.files.map((file) => file.name),
    ['1.png', '2.png', '10.png']
  )
  assert.deepEqual(skipped, [])
})

test('a parent folder makes one post per folder that holds images, whatever the depth', () => {
  const { posts } = groupFiles(
    [
      image('Root/b/one.png'),
      image('Root/a/deep/two.png'),
      image('Root/a/three.png'),
      image('Root/cover.png'),
    ],
    'folder'
  )
  assert.deepEqual(
    posts.map((post) => post.sourceKey),
    ['Root', 'a', 'deep', 'b']
  )
})

test('the same file name in two folders stays two files', () => {
  const { posts } = groupFiles([image('Trip/a/1.png'), image('Trip/b/1.png')], 'folder')
  assert.deepEqual(
    posts.flatMap((post) => post.storedNames),
    ['Trip-a-1.png', 'Trip-b-1.png']
  )
  assert.deepEqual(
    posts.flatMap((post) => post.problems),
    []
  )
})

test('names that would collide once stored are problems, not overwrites', () => {
  const { posts } = groupFiles([image('Trip/a b/1.png'), image('Trip/a-b/1.png')], 'folder')
  assert.match(posts[1]?.problems[0] ?? '', /would be saved under one name/)
})

test('one post per image ignores folders', () => {
  const { posts } = groupFiles([image('Trip/2.png'), image('Trip/1.png')], 'per-image')
  assert.deepEqual(
    posts.map((post) => [post.sourceKey, post.files.length]),
    [
      ['1.png', 1],
      ['2.png', 1],
    ]
  )
})

test('hidden, unsupported and empty files are listed, not dropped silently', () => {
  const { posts, skipped } = groupFiles(
    [
      image('Trip/.DS_Store', 10, ''),
      image('Trip/__MACOSX/1.png'),
      image('Trip/notes.txt', 10, 'text/plain'),
      image('Trip/clip.mp4', 10, 'video/mp4'),
      image('Trip/empty.png', 0),
      image('Trip/keep.png'),
    ],
    'folder'
  )
  assert.equal(posts[0]?.files.length, 1)
  assert.deepEqual(
    skipped.map((entry) => entry.name),
    ['Trip/.DS_Store', 'Trip/__MACOSX/1.png', 'Trip/notes.txt', 'Trip/clip.mp4', 'Trip/empty.png']
  )
})

test('a type the browser left blank is read from the extension', () => {
  assert.equal(groupFiles([image('T/a.JPG', 10, '')], 'folder').posts.length, 1)
})

test('posts over the attachment or size limits say what to fix', () => {
  const many = Array.from({ length: 21 }, (_, index) => image(`Big/${index}.png`))
  assert.match(groupFiles(many, 'folder').posts[0]?.problems[0] ?? '', /21 images.*takes 20/)
  const heavy = image('Big/huge.png', 30_000_000)
  assert.match(groupFiles([heavy], 'folder').posts[0]?.problems[0] ?? '', /huge\.png is over/)
})

test('a dropped folder records its path differently, and groups the same', () => {
  const dropped = { name: '1.png', path: '/Trip/1.png', size: 10, type: 'image/png' }
  assert.equal(isInFolder(dropped), true)
  assert.equal(storedFileName(dropped), 'Trip-1.png')
  assert.equal(groupFiles([dropped], 'folder').posts[0]?.sourceKey, 'Trip')
  assert.equal(isInFolder({ name: 'a.png', path: './a.png', size: 1, type: '' }), false)
})

test('a long path keeps its extension when stored', () => {
  const name = storedFileName(image(`${'deep/'.repeat(40)}photo.png`))
  assert.ok(name.length <= 128)
  assert.ok(name.endsWith('photo.png'))
})
