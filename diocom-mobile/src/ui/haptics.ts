import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

/** Haptic feedback that never throws (web and some Android devices have no haptics engine). */
const enabled = Platform.OS === 'ios' || Platform.OS === 'android';

export const haptic = {
    tap() {
        if (enabled) void Haptics.selectionAsync().catch(() => undefined);
    },
    light() {
        if (enabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    },
    medium() {
        if (enabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    },
    success() {
        if (enabled) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    },
    warning() {
        if (enabled) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    },
    error() {
        if (enabled) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    },
};
