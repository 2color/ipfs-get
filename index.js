#!/usr/bin/env node
import fs from 'fs'
import meow from 'meow'
import fetch from 'isomorphic-unfetch'
import { bytes } from 'multiformats'
import { sha256 } from 'multiformats/hashes/sha2'
import { CarReader } from '@ipld/car'
import exporter from 'ipfs-unixfs-exporter'
import toIterable from 'stream-to-it'
import { pipe } from 'it-pipe'

const { toHex } = bytes

const hashes = {
  [sha256.code]: sha256
}

const options = {
  importMeta: import.meta,
  flags: {
    gateway: {
      type: 'string',
      alias: 'g',
      default: 'http://127.0.0.1:5001'
    },
    output: {
      type: 'string',
      alias: 'o'
    }
  }
}

const cli = meow(`
  Usage
  $ ipfs-get <cid>
`, options)

ipfsGet({
  cid: cli.input[0],
  gateway: new URL(cli.flags.gateway),
  output: cli.flags.output
})

async function ipfsGet ({ cid, gateway, output }) {
  console.log(`📡 Fetching .car file from ${gateway}`)
  const carStream = await fetchCar(cid, gateway)
  const carReader = await CarReader.fromIterable(carStream)

  let count = 0
  const verifyingBlockService = {
    get: async (cid) => {
      const res = await carReader.get(cid)
      if (!isValid(res)) {
        throw new Error(`Bad block. Hash does not match CID ${cid}`)
      }
      count++
      return res
    }
  }

  await extractCar({ cid, blockService: verifyingBlockService, output })
  console.log(`🔐 Verified ${count}/${count} block${count === 1 ? '' : 's'}`)
  console.log(`✅ Wrote ${output || cid}`)
}

async function extractCar ({ cid, blockService, output }) {
  // magic extracted from js-ipfs:
  // https://github.com/ipfs/js-ipfs/blob/46618c795bf5363ba3186645640fb81349231db7/packages/ipfs-core/src/components/get.js#L20
  // https://github.com/ipfs/js-ipfs/blob/46618c795bf5363ba3186645640fb81349231db7/packages/ipfs-cli/src/commands/get.js#L56-L66
  for await (const file of exporter.recursive(cid, blockService, { /* options */ })) {
    let filePath = file.path
    // output overrides the first part of the path.
    if (output) {
      const parts = file.path.split('/')
      parts[0] = output
      filePath = parts.join('/')
    }
    console.log(filePath, file)
    if (file.type === 'directory') {
      await fs.promises.mkdir(filePath, { recursive: true })
    } else {
      await pipe(
        file.content,
        toIterable.sink(fs.createWriteStream(filePath))
      )
    }
  }
}

async function fetchCar (cid, gateway) {
  const url = `${gateway}api/v0/dag/export?arg=${cid}`
  const res = await fetch(url, { method: 'POST' })
  if (res.status > 400) {
    throw new Error(`${res.status} ${res.statusText} ${url}`)
  }
  return res.body
}

async function isValid ({ cid, bytes }) {
  const hashfn = hashes[cid.multihash.code]
  if (!hashfn) {
    throw new Error(`Missing hash function for ${cid.multihash.code}`)
  }
  const hash = await hashfn.digest(bytes)
  return toHex(hash.digest) === toHex(cid.multihash.digest)
}