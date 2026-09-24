---
id: teaching
part: business
title: Teaching and explanation
summary: Explaining complex ideas simply without losing precision: know the learner, concrete before abstract, analogies with limits, build up in layers, define jargon, check understanding and use visuals.
terms: explain explanation teach teaching learn learning tutorial simple simplify eli5 beginner concept intuition analogy example jargon define understand clarify lesson course walk through step by step
tools: claim_check
skills: natural-editorial-writing storytelling presentation-authoring data-viz
---

# Teaching and explanation

Explaining is translating a mental model from one head into another. The expert's curse is forgetting what it was like not to know. Good explanations start where the learner is, build intuition before formalism, and keep the necessary technical terms while making each one meaningful.

## Start from what the learner already knows {#learner}
<!-- terms: learner prior knowledge beginner expert level background assume audience starting point -->

**Principle.** Find out, or reasonably infer, what the learner already knows, and connect each new idea to something familiar.

**Why.** New knowledge sticks when attached to existing knowledge. Explanations pitched too high lose the learner at the first unexplained concept; pitched too low they bore and patronize. Asking a quick question or offering a layered explanation (short version, then details) adapts to the learner.

**Signals.** Explanations that assume unstated background; no attempt to calibrate to the learner's level.

**Ask.** What does this learner already know that the new idea can build on?

**Traps.** Assuming beginners cannot handle correct terminology.

## Concrete before abstract {#concrete-first}
<!-- terms: concrete example abstract general rule specific case worked example instance -->

**Principle.** Show a specific example first, then generalize to the rule, then return to further examples.

**Why.** Abstract definitions are hard to grasp without instances; examples give the mind something to hold. Worked examples followed by generalization let learners induce the pattern themselves, which improves retention. Varied examples reveal which features matter and which are incidental.

**Signals.** Explanations that begin with formal definitions; rules without examples; a single example that hides the general pattern.

**Ask.** What concrete example would make this idea click before the general statement?

**Traps.** Examples so specific the general rule is never stated.

## Analogies illuminate, then name their limits {#analogies}
<!-- terms: analogy metaphor like compare comparison intuition limit breaks down mental model -->

**Principle.** Use analogies to build intuition quickly, and state where each analogy breaks down so it does not become a misconception.

**Why.** A good analogy transfers a whole structure of understanding at once ("a hash map is like a coat check"). But every analogy is wrong somewhere, and learners over-extend them. Saying explicitly "unlike a coat check, two coats can land on the same hook" turns the limit into additional understanding.

**Signals.** Analogies presented as exact; misconceptions traceable to an over-extended metaphor.

**Ask.** Where does this analogy stop being accurate, and has that been said?

**Traps.** Stacking several analogies that conflict.

## Build in layers {#layers}
<!-- terms: layers progressive complexity build up step by step scaffold simple version detail depth -->

**Principle.** Present the simplest correct model first, then add layers of detail and exceptions, each resting on the previous one.

**Why.** Learners cannot absorb all nuances at once. A simplified but correct first layer ("an LLM predicts the next token") gives a frame; subsequent layers refine it (tokenization, attention, sampling). Each layer should be true at its level of detail, never a falsehood that must later be unlearned.

**Signals.** Explanations that dump every detail at once; simplifications that are actually wrong.

**Ask.** What is the simplest correct version of this idea, and what layer comes next?

**Traps.** Stopping at the simple layer when the learner needs depth.

## Keep the jargon, define it {#jargon}
<!-- terms: jargon terminology term define definition vocabulary technical words acronym glossary -->

**Principle.** Use the correct technical terms, but define each at first use in plain words and use it consistently afterward.

**Why.** Avoiding jargon entirely leaves learners unable to read further material or talk with practitioners; unexplained jargon excludes them. Introducing a term with a plain definition and an example gives both accessibility and precision. Consistency matters: switching between synonyms makes learners think there are several concepts.

**Signals.** Undefined acronyms; synonyms used interchangeably for one concept; explanations that avoid necessary terms entirely.

**Ask.** Is every technical term defined at first use and used consistently?

**Traps.** Defining terms the audience already knows well.

## Check understanding, do not assume it {#check}
<!-- terms: check understanding question quiz explain back feynman test apply practice exercise -->

**Principle.** Verify understanding by having the learner apply the idea, predict an outcome or explain it back—not by asking "does that make sense?"

**Why.** People say they understand when they do not. Application reveals gaps: predicting what code prints, solving a small variant, explaining in their own words (the Feynman technique). For written explanations, including a short exercise or a "check yourself" question serves the same purpose.

**Signals.** Long explanations without any application; "does that make sense?" as the only check.

**Ask.** What small task would show whether this explanation was understood?

**Traps.** Quizzing that feels like an exam rather than help.

## Pictures carry structure {#visuals}
<!-- terms: diagram visual picture sketch chart illustration flow diagram structure relationships -->

**Principle.** Use diagrams for structure, flow and relationships—things that are spatial or sequential—and words for reasoning.

**Why.** A system diagram shows in seconds what paragraphs describe slowly; a timeline clarifies sequence; a chart makes a trend obvious. Diagrams must be simple, labeled and focused on one idea. Combining words and pictures (dual coding) improves learning because each channel reinforces the other.

**Signals.** Architectures or processes explained only in text; cluttered diagrams trying to show everything.

**Ask.** Is there a structure or flow here that a simple diagram would make clearer?

**Traps.** Decorative diagrams that add nothing to understanding.
