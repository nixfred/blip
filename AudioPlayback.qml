import QtQuick
import QtMultimedia
Item {
  id: root
  property url source: ""
  property bool playing: false
  property bool muted: false
  property int resetToken: 0
  readonly property real position: player.position
  readonly property real duration: player.duration
  readonly property bool seekable: player.seekable
  readonly property bool actuallyPlaying: player.playbackState === MediaPlayer.PlayingState
  readonly property bool ready: player.mediaStatus === MediaPlayer.LoadedMedia || player.mediaStatus === MediaPlayer.BufferedMedia || player.mediaStatus === MediaPlayer.EndOfMedia
  readonly property bool decodeFailed: player.error !== MediaPlayer.NoError
  signal playbackEnded()
  signal playbackFailed()
  function seek(ms) { player.position = ms }
  onPlayingChanged: {
    if (playing && String(source) !== "") {
      if (player.mediaStatus === MediaPlayer.EndOfMedia) player.position = 0
      player.play()
    } else player.pause()
  }
  onResetTokenChanged: player.stop()
  Component.onDestruction: player.stop()
  MediaPlayer {
    id: player
    source: root.source
    audioOutput: AudioOutput { muted: root.muted }
    onMediaStatusChanged: {
      if (mediaStatus === MediaPlayer.LoadedMedia && root.playing) play()
      else if (mediaStatus === MediaPlayer.EndOfMedia) root.playbackEnded()
    }
    onErrorOccurred: root.playbackFailed()
  }
}
