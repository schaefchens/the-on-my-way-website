package app.omw.omwnative

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * TokenVault.get/set/clear for JS. The uploader reads the same vault directly; a new token lets
 * jobs that waited as "unauthorized" go on (the refused token is remembered by its hash only).
 */
class OmwTokenVaultModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("OmwTokenVault")

    AsyncFunction("get") { -> TokenVault(context).get() }

    AsyncFunction("set") { token: String ->
      TokenVault(context).set(token)
      UploadScheduler.schedule(context)
    }

    AsyncFunction("clear") { ->
      TokenVault(context).clear()
      UploadScheduler.schedule(context)
    }
  }
}
