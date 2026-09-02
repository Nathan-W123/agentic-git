/**
 * Who the sentence says is going to do the thing.
 *
 * The embedding filter beside this reads a message for *meaning*, and that is
 * exactly why it cannot answer this question. "I can probably wire that up"
 * and "wire that up" mean almost the same thing to a sentence encoder — the
 * difference between them is not semantic, it is grammatical, and it is the
 * whole difference between a colleague thinking out loud and somebody asking
 * for work.
 *
 * Measured, on the four messages that actually did this in a live channel:
 *
 *   "I can probably wire back api pretty easily"                    +0.058
 *   "Claude is saying ur running old code that's why u can't ..."   +0.143
 *   "Uninstall isnt needed just install"                            +0.017
 *   "im working on the accel applications - but i still think ..."  +0.123
 *
 * Every one of them on the work side of the line, every one of them people
 * talking to each other, and every one of them dispatched to an agent that
 * then had to be stopped by hand. Against a wider sample of the same channel
 * the embedding alone fired on **16 of 29** ordinary remarks. No arrangement
 * of prototypes fixed that: the two classes overlap in embedding space, so
 * every prototype that pushed a misfire down pulled a real request with it.
 *
 * This is the orthogonal half. On the same sample it takes the false fires
 * from 16 to 3 and costs **nothing** — 0 of 25 genuine requests are lost,
 * because a request for work does not have the speaker as its subject.
 *
 * ### Why this is not the word list that was removed
 *
 * A word list was tried for "is this a task" and rightly removed: it listed
 * *what people talk about*, and subject matter has no edge — every new
 * feature is a new noun, and the list grows forever and is always behind.
 *
 * This lists neither nouns nor verbs. It is pronouns and auxiliaries: a
 * closed class of English that has not gained a member in centuries. It
 * cannot fall behind the product, because it does not know anything about
 * the product.
 *
 * ### Which way it fails
 *
 * Toward silence, deliberately, and that asymmetry is the same one the rest
 * of this path is built on. A request this vetoes costs a person one
 * @mention, which always works. A remark it lets through spends somebody's
 * real subscription on work nobody asked for, and has to be found and
 * stopped. Those are not the same price.
 */

/**
 * The speaker is the actor: first person, doing or having done or able to.
 *
 * "we should" is deliberately absent — that is somebody proposing work, and
 * it lives in the request vocabulary on the addressed path rather than here.
 * "we shipped" is present, because it is a report of work already finished.
 */
const SPEAKER_IS_ACTOR_RE =
  /\b(?:i|we)\s*(?:'|’)?(?:ll|ve|m|re)\b|\bi(?:'|’)?m\b|\bim\s+(?:working|going|gonna|about|trying|just)\b|\b(?:i|we)\s+(?:can|could|will|would|already|just|think|thought|reckon|guess|feel|believe|need to|tried|tries|have|had|might|may)\b|\bwe\s+(?:shipped|merged|deployed|released|cut|pushed|landed)\b/iu;

/**
 * Relaying what somebody or something else said.
 *
 * "Claude is saying ur running old code" is the sentence that made this its
 * own clause: it is a bug report in vocabulary and a quotation in grammar,
 * and it leaned further toward work (+0.143) than any other real misfire.
 * Passing on what a tool told you is not asking for anything.
 */
const REPORTED_SPEECH_RE =
  /\b(?:says?|saying|said|reckons?|apparently|turns out|sounds like|according to)\b/iu;

/**
 * Whether this message says the speaker — or someone they are quoting — is
 * the one acting, rather than asking anyone else to.
 *
 * Cheap and synchronous on purpose: it runs before the embedding and before
 * any provider turn, so on both kinds of deployment it is the gate that costs
 * nothing to be right about.
 */
export function speakerIsActor(text: string): boolean {
  return SPEAKER_IS_ACTOR_RE.test(text) || REPORTED_SPEECH_RE.test(text);
}
