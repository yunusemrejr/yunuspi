"""Compute independent one-step value targets from a JSON fixture on stdin.
Each transition needs reward, next_value, terminated and truncated; gamma is global.
Use the final pre-reset observation to obtain next_value for truncated episodes.
"""
import json
import math
import sys


def targets(data):
    def finite(value, name):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f'{name} must be a finite number')
        return value
    gamma = finite(data['gamma'], 'gamma')
    if not 0 <= gamma <= 1:
        raise ValueError('gamma must be between 0 and 1')
    if not isinstance(data['transitions'], list):
        raise ValueError('transitions must be a list')
    result = []
    for row in data['transitions']:
        if type(row['terminated']) is not bool or type(row['truncated']) is not bool:
            raise ValueError('terminated and truncated must be booleans')
        reward = finite(row['reward'], 'reward')
        next_value = finite(row['next_value'], 'next_value')
        result.append(finite(reward + (0 if row['terminated'] else gamma * next_value), 'target'))
    return result


if __name__ == '__main__':
    try:
        print(json.dumps({'targets': targets(json.load(sys.stdin))}, allow_nan=False))
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        print(f'Invalid trajectory fixture: {error}', file=sys.stderr)
        sys.exit(1)
