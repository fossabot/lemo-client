import BigNumber from 'bignumber.js'
import {Buffer} from 'safe-buffer'
import {encode} from './rlp'
import {CHAIN_ID, TX_VERSION, TTTL} from './config'
import {sign, recover, pubKeyToAddress, keccak256, decodeAddress} from './crypto'
import {has0xPrefix, toBuffer, bufferTrimLeft, setBufferLength} from './utils'


export default class Tx {
    /**
     * Create transaction object
     * @param {object} txConfig
     * @param {number?} txConfig.type The type of transaction. 0: normal
     * @param {number?} txConfig.version The version of transaction protocol
     * @param {number?} txConfig.chainId Chain id from LemoChain
     * @param {string} txConfig.to The transaction recipient address
     * @param {string?} txConfig.toName The transaction recipient name
     * @param {number|string?} txConfig.gasPrice=3000000000 Gas price for smart contract
     * @param {number|string?} txConfig.gasLimit=2000000 Max gas limit for smart contract
     * @param {number|string?} txConfig.amount Unit is wei
     * @param {Buffer|string?} txConfig.data Extra data or smart contract calling parameters
     * @param {number?} txConfig.expirationTime Default value is half hour from now
     * @param {string?} txConfig.message Extra value data
     * @param {Buffer|string?} txConfig.r Signature data
     * @param {Buffer|string?} txConfig.s Signature data
     * @param {Buffer|string?} txConfig.v Signature data, it also contains type, version, and chainId for transaction
     */
    constructor(txConfig) {
        if (txConfig.v) {
            this.v = txConfig.v
            const parsedV = parseV(txConfig.v)
            this.type = parsedV.type
            this.version = parsedV.version
            this.chainId = parsedV.chainId
        } else {
            this.type = txConfig.type || 0
            this.version = txConfig.version || TX_VERSION
            this.chainId = txConfig.chainId || CHAIN_ID
            this.v = combineV(this.type, this.version, 0, this.chainId)
        }
        this.to = txConfig.to || ''
        this.toName = txConfig.toName || ''
        this.gasPrice = txConfig.gasPrice || 3000000000
        this.gasLimit = txConfig.gasLimit || 2000000
        this.amount = txConfig.amount || 0
        this.data = txConfig.data || ''
        // seconds
        this.expirationTime = txConfig.expirationTime || (Math.floor(Date.now() / 1000) + TTTL)
        this.message = txConfig.message || ''
        this.r = txConfig.r || ''
        this.s = txConfig.s || ''
        this.from = ''
    }

    /**
     * rlp encode for hash
     * @return {Buffer}
     */
    serialize() {
        const raw = [
            toRaw(this, 'to', false, 20),
            toRaw(this, 'toName', false),
            toRaw(this, 'gasPrice', true),
            toRaw(this, 'gasLimit', true),
            toRaw(this, 'amount', true),
            toRaw(this, 'data', true),
            toRaw(this, 'expirationTime', true),
            toRaw(this, 'message', false),
            toRaw(this, 'v', true),
            toRaw(this, 'r', true),
            toRaw(this, 's', true),
        ]

        return encode(raw)
    }

    hash() {
        return keccak256(this.serialize())
    }

    /**
     * format for rpc
     * @return {object}
     */
    toJson() {
        const to = (has0xPrefix(this.to)) ? toHexStr(this, 'to', 20) : this.to
        const result = {
            gasPrice: new BigNumber(this.gasPrice).toString(10),
            gasLimit: new BigNumber(this.gasLimit).toString(10),
            amount: new BigNumber(this.amount).toString(10),
            expirationTime: new BigNumber(this.expirationTime).toString(10),
            v: toHexStr(this, 'v'),
            r: toHexStr(this, 'r'),
            s: toHexStr(this, 's'),
        }
        if (to) {
            result.to = to
        }
        if (this.toName) {
            result.toName = this.toName
        }
        if (this.data && this.data.length) {
            result.data = toHexStr(this, 'data')
        }
        if (this.message) {
            result.message = this.message
        }
        return result
    }

    /**
     * @param {string|Buffer} privateKey
     * @return {Buffer} The signed transaction's hash
     */
    sign(privateKey) {
        privateKey = toBuffer(privateKey)
        new Signer().sign(this, privateKey)
        return this.hash()
    }

    /**
     * Recover from address from a signed transaction
     * @return {string}
     */
    recover() {
        new Signer().recover(this)
        return this.from
    }
}

class Signer {
    sign(tx, privateKey) {
        const sig = sign(privateKey, this.hashForSign(tx))
        tx.v = combineV(tx.type, tx.version, sig.recovery, tx.chainId)
        tx.r = sig.r
        tx.s = sig.s
    }

    recover(tx) {
        const recovery = parseV(tx.v).recovery
        const pubKey = recover(this.hashForSign(tx), recovery, tx.r, tx.s)
        if (!pubKey) {
            throw new Error('invalid signature')
        }
        tx.from = pubKeyToAddress(pubKey)
    }

    hashForSign(tx) {
        const raw = [
            toRaw(tx, 'type', true),
            toRaw(tx, 'version', true),
            toRaw(tx, 'chainId', true),
            toRaw(tx, 'to', false, 20),
            toRaw(tx, 'toName', false),
            toRaw(tx, 'gasPrice', true),
            toRaw(tx, 'gasLimit', true),
            toRaw(tx, 'amount', true),
            toRaw(tx, 'data', true),
            toRaw(tx, 'expirationTime', true),
            toRaw(tx, 'message', false),
        ]

        return keccak256(encode(raw))
    }
}

// v is combined by these properties:
//     type    version  secp256k1.recovery  chainId
// |----8----|----7----|--------1--------|----16----|

// CombineV combines type, version, chainId together to generate V
function combineV(type, version, recovery, chainId) {
    type = (type % (1 << 8)) << 24
    version = (version % (1 << 7)) << 17
    recovery = (recovery % (1 << 1)) << 16
    chainId %= 1 << 16
    return type | version | recovery | chainId
}

// ParseV split v to 4 parts
function parseV(v) {
    const type = (v >> 24) % (1 << 8)
    const version = (v >> 17) % (1 << 7)
    const recovery = (v >> 16) % (1 << 1)
    const chainId = v % (1 << 16)
    return {type, version, recovery, chainId}
}

function toRaw(tx, fieldName, isNumber, length) {
    let data = tx[fieldName]
    if (fieldName === 'to') {
        data = decodeAddress(data)
    }
    if (isNumber && !Buffer.isBuffer(data)) {
        // parse number in string (e.g. "0x10" or "16") to real number. or else it will be encode by ascii
        data = new BigNumber(data)
    }
    data = toBuffer(data)
    if (length) {
        if (data.length > length) {
            throw new Error(`The field ${fieldName} must less than ${length} bytes`)
        }
        data = setBufferLength(data, length, false)
    } else {
        data = bufferTrimLeft(data)
    }
    return data
}

function toHexStr(tx, fieldName, length) {
    const str = toRaw(tx, fieldName, true, length).toString('hex')
    return str ? `0x${str}` : ''
}
