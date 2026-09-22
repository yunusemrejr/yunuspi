// Deterministic, synthetic trace-level feature fixtures. These fixtures are
// deliberately small and human-auditable; they are not production prevalence
// estimates. Feature order is documented alongside guardian-features.js.
function rng(seed) {
	let value = seed >>> 0;
	return () => {
		value = (value + 0x6d2b79f5) >>> 0;
		let next = value;
		next = Math.imul(next ^ (next >>> 15), next | 1);
		next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
		return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
	};
}

function vary(base, random, amount = 55) {
	return base.map((value, index) => {
		if (index === 11) return value;
		const delta = Math.round((random() * 2 - 1) * amount);
		return Math.max(0, Math.min(1000, value + delta));
	});
}

const POSITIVE = [760, 980, 990, 910, 1000, 900, 1000, 1000, 970, 1000, 900, 1000];
const NEGATIVES = [
	[0, 980, 0, 900, 1000, 900, 1000, 1000, 970, 0, 900, 1000], // same successful tool call
	[760, 700, 990, 910, 1000, 900, 1000, 1000, 700, 1000, 900, 1000], // changed arguments
	[760, 980, 650, 910, 1000, 900, 1000, 1000, 970, 1000, 900, 1000], // non-failure result
	[760, 980, 990, 350, 1000, 900, 1000, 1000, 970, 1000, 350, 1000], // no retry decision opportunity
	[760, 980, 990, 910, 1000, 100, 1000, 1000, 970, 1000, 900, 1000], // stale trace
	[760, 980, 990, 910, 1000, 900, 1000, 0, 970, 1000, 900, 1000], // wrong task lineage
	[760, 980, 990, 910, 1000, 900, 1000, 1000, 970, 1000, 900, 0], // verified user retry request
	[250, 980, 990, 910, 1000, 900, 1000, 1000, 970, 1000, 900, 1000], // too few repeats
];

export function makeGuardianCases() {
	const random = rng(0x47a19c2d);
	const train = [];
	const calibration = [];
	const heldout = [];
	for (let i = 0; i < 48; i++) train.push({ id: `train-positive-${i + 1}`, split: "train", category: "repeated-failure", label: 1, features: vary(POSITIVE, random) });
	for (let i = 0; i < 48; i++) {
		const source = NEGATIVES[i % NEGATIVES.length];
		train.push({ id: `train-negative-${i + 1}`, split: "train", category: "non-intervention", label: 0, features: vary(source, random) });
	}
	for (let i = 0; i < 16; i++) calibration.push({ id: `cal-positive-${i + 1}`, split: "calibration", category: "repeated-failure", label: 1, features: vary(POSITIVE, random, 35) });
	for (let i = 0; i < 16; i++) {
		const source = NEGATIVES[i % NEGATIVES.length];
		calibration.push({ id: `cal-negative-${i + 1}`, split: "calibration", category: "non-intervention", label: 0, features: vary(source, random, 35) });
	}
	for (let i = 0; i < 24; i++) heldout.push({ id: `heldout-positive-${i + 1}`, split: "heldout", category: "repeated-failure", label: 1, features: vary(POSITIVE, random, 70) });
	for (let i = 0; i < 24; i++) {
		const source = NEGATIVES[i % NEGATIVES.length];
		heldout.push({ id: `heldout-negative-${i + 1}`, split: "heldout", category: "non-intervention", label: 0, features: vary(source, random, 35) });
	}
	const adversarial = [
		NEGATIVES[0], // successful repetitions wrapped in failure-looking tool text
		NEGATIVES[1], // same family, different target values
		NEGATIVES[2], // status-only result that contains the word "error"
		NEGATIVES[3], // repeated by the model without observing an intervening result
		NEGATIVES[4], // stale old task activity
		NEGATIVES[5], // activity from another task
		NEGATIVES[6], // user explicitly asks for the retry
		NEGATIVES[7], // only one repeated retry
		[1000, 999, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 0], // near-perfect but user override
		[1000, 999, 1000, 300, 1000, 1000, 1000, 1000, 1000, 1000, 300, 1000], // no observed decision opportunity
		[1000, 999, 750, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], // apparent repeated calls, mixed outcomes
		[400, 999, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000], // just below repeat gate
	];
	for (let i = 0; i < 12; i++) {
		heldout.push({ id: `adversarial-${i + 1}`, split: "heldout", category: "adversarial-negative", label: 0, features: vary(adversarial[i], random, i < 8 ? 20 : 0) });
	}
	return { featureCount: 12, train, calibration, heldout };
}
