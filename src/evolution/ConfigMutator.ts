
import { ACSConfig } from '../core/SystemConfig';

export class ConfigMutator {

    /**
     * Returns a mutated copy of the config.
     * "Evolutionary Drift"
     */
    public static mutate(config: ACSConfig): ACSConfig {
        const newConfig = { ...config };

        // Randomly pick a property to mutate
        const keys = Object.keys(newConfig) as (keyof ACSConfig)[];
        const targetKey = keys[Math.floor(Math.random() * keys.length)];

        // Mutation strength: +/- 10%
        const mutation = 1.0 + ((Math.random() * 0.2) - 0.1);

        // Only mutate numeric values
        if (typeof newConfig[targetKey] === 'number') {
            let val = newConfig[targetKey] as number;
            val = val * mutation;

            // Safety clamps (Don't break the system)
            if (targetKey.includes('Threshold') && val < 1) val = 1;
            if (targetKey.includes('Ratio') && val > 1) val = 0.99;

            // Apply
            (newConfig as any)[targetKey] = val;

            // console.log(`[Meta-Evo] Mutated ${targetKey}: ${config[targetKey].toFixed(2)} -> ${val.toFixed(2)}`);
        }

        return newConfig;
    }
}
