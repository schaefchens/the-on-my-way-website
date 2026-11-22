package app.omw.omwnative

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The app token, AES-GCM-encrypted with a non-exportable Android Keystore key, in an atomic file
 * under noBackupFilesDir (never in backups, WorkManager data or JobInfo extras). Readable by JS
 * (OmwTokenVault) and by the native uploader without JS. No user authentication is bound to the
 * key: a background upload cannot show a biometric prompt, and adding a fingerprint must not
 * destroy the token (app-plan §4 "Auth storage").
 *
 * File format: version byte 1 | 12-byte IV | ciphertext + 16-byte tag.
 */
class TokenVault(context: Context) {
  private val file = AtomicFile(File(context.noBackupFilesDir, FILE_NAME))

  @Synchronized
  fun get(): String? {
    val bytes = try {
      file.readFully()
    } catch (_: FileNotFoundException) {
      return null
    }
    if (bytes.size < 1 + IV_BYTES + TAG_BITS / 8 || bytes[0] != VERSION) return null
    val key = existingKey() ?: return null
    return try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, bytes, 1, IV_BYTES))
      String(cipher.doFinal(bytes, 1 + IV_BYTES, bytes.size - 1 - IV_BYTES), Charsets.UTF_8)
    } catch (_: Exception) {
      // Key lost (e.g. restored device) or file damaged: behave as "not paired".
      null
    }
  }

  @Synchronized
  fun set(token: String) {
    require(token.isNotEmpty() && token.length <= 512) { "Token must be 1..512 chars" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: createKey())
    val iv = cipher.iv
    check(iv.size == IV_BYTES) { "Unexpected IV size ${iv.size}" }
    val sealed = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
    val out = file.startWrite()
    try {
      out.write(byteArrayOf(VERSION))
      out.write(iv)
      out.write(sealed)
      file.finishWrite(out)
    } catch (e: Exception) {
      file.failWrite(out)
      throw e
    }
  }

  @Synchronized
  fun clear() {
    file.delete()
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun existingKey(): SecretKey? = (keyStore().getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

  private fun createKey(): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "omw.token-vault.v1"
    private const val FILE_NAME = "omw-token.vault"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val VERSION: Byte = 1
  }
}
