package io.github.viren070.aiostreams.playback

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper

/** What media plays to now, as far as the Dolby Atmos renders care. */
enum class OutputKind { SPEAKERS, HEADPHONES, OTHER }

/**
 * The kind of output media plays to, kept current as devices come and go. Android sends media to
 * headphones while any are connected, then to an HDMI, USB or line output, then to the device's
 * own speaker. A Bluetooth speaker reports itself as A2DP like headphones do, so it counts as
 * headphones; the Channels setting's explicit choices cover it.
 */
class AudioRoute(context: Context, private val onChange: (OutputKind) -> Unit = {}) {
    private val audio = context.getSystemService(AudioManager::class.java)

    @Volatile
    var current: OutputKind = read()
        private set

    private val callback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = update()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = update()
    }

    init {
        audio.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
    }

    fun release() = audio.unregisterAudioDeviceCallback(callback)

    private fun update() {
        val next = read()
        if (next == current) return
        current = next
        onChange(next)
    }

    private fun read(): OutputKind {
        val types = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }.toSet()
        return when {
            types.any { it in HEADPHONES } -> OutputKind.HEADPHONES
            types.any { it in OTHER } -> OutputKind.OTHER
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER in types -> OutputKind.SPEAKERS
            else -> OutputKind.OTHER
        }
    }

    private companion object {
        // Numbers for the constants newer than the minimum API level; a device without them never reports them.
        val HEADPHONES = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            22, // TYPE_USB_HEADSET
            23, // TYPE_HEARING_AID
            26, // TYPE_BLE_HEADSET
        )
        val OTHER = setOf(
            AudioDeviceInfo.TYPE_HDMI,
            AudioDeviceInfo.TYPE_HDMI_ARC,
            29, // TYPE_HDMI_EARC
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_ACCESSORY,
            AudioDeviceInfo.TYPE_DOCK,
            AudioDeviceInfo.TYPE_LINE_ANALOG,
            AudioDeviceInfo.TYPE_LINE_DIGITAL,
            AudioDeviceInfo.TYPE_AUX_LINE,
            27, // TYPE_BLE_SPEAKER
        )
    }
}

/** The Dolby Atmos render for the Channels setting on this output, or null for mpv's own decode. */
fun atmosRender(audioChannels: String, output: OutputKind): OutputKind? = when (audioChannels) {
    "speakers" -> OutputKind.SPEAKERS
    "headphones" -> OutputKind.HEADPHONES
    "auto" -> output.takeIf { it != OutputKind.OTHER }
    else -> null
}
