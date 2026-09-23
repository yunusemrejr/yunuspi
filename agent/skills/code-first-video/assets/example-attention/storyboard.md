# How attention works (≈36 s, 1920×1080, 30 fps)

Audience: curious non-specialists. Promise: in half a minute, see why "attention" lets a model resolve meaning.

## 01 · ambiguity (8s)
Claim: a word's meaning depends on other words.
Visual system: the sentence as a row of token chips; "it" lifts and glows, a question mark hovers.
Motion: chips land left→right (reading order); "it" rises and pulses once.
On-screen text: "What does “it” refer to?"
Narration: "In this sentence, what does the word it refer to? You know instantly. A model has to work it out."
Cues: tokens 0.3, focus 2.4, question 3.2

## 02 · weights (10s)
Claim: attention scores every other word for relevance.
Visual system: same token row (continuity); arcs grow from "it" to every token, thickness and brightness = weight; "animal" wins.
Motion: arcs grow outward from "it" in reading order; the strongest arc thickens last; "animal" highlights.
On-screen text: "Attention = learned relevance"
Narration: "Attention lets it look at every other word and score how relevant each one is. Here, the strongest link points to animal."
Cues: arcs 0.6, winner 5.0, label 6.2

## 03 · matrix (10s)
Claim: doing this for every word at once is a matrix.
Visual system: attention matrix, rows = the word looking, columns = words looked at; heat = weight; the row for "it" outlined.
Motion: cells fill row by row; the "it" row highlights and others dim.
On-screen text: "Every word attends to every word"
Narration: "Every word does this at the same time. The result is a grid of weights, one row per word, computed in parallel."
Cues: matrix 0.4, highlight 5.5, label 6.0

## 04 · stack (8s)
Claim: stacking attention layers builds understanding; this is the transformer.
Visual system: a network whose layers light up in sequence, labelled as attention layers.
Motion: layers build, a signal wave passes through, title lands.
On-screen text: "Attention is all you need · 2017"
Narration: "Stack many of these layers, and you get the transformer, the architecture behind today's language models."
Cues: network 0.2, signal 1.8, title 3.4
