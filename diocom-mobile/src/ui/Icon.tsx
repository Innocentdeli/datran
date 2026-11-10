import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';

import { colors } from '../theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

interface IconProps {
    name: IconName;
    size?: number;
    color?: string;
}

/** Single icon family (Ionicons) across the app for visual consistency. */
export function Icon({ name, size = 20, color = colors.text }: IconProps) {
    return <Ionicons name={name} size={size} color={color} accessibilityElementsHidden importantForAccessibility="no" />;
}
