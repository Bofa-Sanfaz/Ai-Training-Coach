package app.trainingpartner.swims

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.samsung.android.sdk.health.data.HealthDataService
import com.samsung.android.sdk.health.data.HealthDataStore
import com.samsung.android.sdk.health.data.error.ResolvablePlatformException
import com.samsung.android.sdk.health.data.permission.AccessType
import com.samsung.android.sdk.health.data.permission.Permission
import com.samsung.android.sdk.health.data.request.DataType
import com.samsung.android.sdk.health.data.request.DataTypes
import com.samsung.android.sdk.health.data.request.LocalTimeFilter
import com.samsung.android.sdk.health.data.request.Ordering
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Reads exercise sessions (used for pool and open-water swims, which Samsung Health
 * does not share with Health Connect) from Samsung Health via the Samsung Health Data SDK.
 * Read-only. Needs Samsung Health 6.30.2+ and, for an unregistered personal app,
 * Samsung Health → Settings → About → (tap version 10×) → Developer mode → Data read ON.
 */
@CapacitorPlugin(name = "SamsungSwims")
class SamsungSwimsPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val permissions = setOf(Permission.of(DataTypes.EXERCISE, AccessType.READ))

    private fun store(): HealthDataStore = HealthDataService.getStore(context)

    private fun errorText(e: Throwable): String = "${e.javaClass.simpleName}: ${e.message ?: ""}".trim()

    @PluginMethod
    fun status(call: PluginCall) {
        scope.launch {
            try {
                val granted = withContext(Dispatchers.IO) { store().getGrantedPermissions(permissions) }
                call.resolve(JSObject().put("available", true).put("granted", granted.containsAll(permissions)))
            } catch (e: Throwable) {
                call.resolve(JSObject().put("available", false).put("granted", false).put("error", errorText(e)))
            }
        }
    }

    @PluginMethod
    fun requestAccess(call: PluginCall) {
        scope.launch {
            try {
                val granted = store().requestPermissions(permissions, activity)
                call.resolve(JSObject().put("granted", granted.containsAll(permissions)))
            } catch (e: Throwable) {
                if (e is ResolvablePlatformException && e.hasResolution) {
                    e.resolve(activity)
                    call.resolve(JSObject().put("granted", false).put("resolving", true).put("error", errorText(e)))
                } else {
                    call.resolve(JSObject().put("granted", false).put("error", errorText(e)))
                }
            }
        }
    }

    /** startDate / endDate: ISO instants. Returns every exercise session in that window. */
    @PluginMethod
    fun readSessions(call: PluginCall) {
        val from = call.getString("startDate")
        val to = call.getString("endDate")
        if (from == null || to == null) { call.reject("startDate and endDate are required"); return }
        val withLog = call.getBoolean("withLog", true) ?: true
        scope.launch {
            try {
                val zone = ZoneId.systemDefault()
                val filter = LocalTimeFilter.of(
                    LocalDateTime.ofInstant(Instant.parse(from), zone),
                    LocalDateTime.ofInstant(Instant.parse(to), zone)
                )
                // Paged: Samsung Health returns at most one page per call
                val points = withContext(Dispatchers.IO) {
                    val all = mutableListOf<com.samsung.android.sdk.health.data.data.HealthDataPoint>()
                    var token: String? = null
                    var pages = 0
                    do {
                        val b = DataTypes.EXERCISE.readDataRequestBuilder
                            .setLocalTimeFilter(filter)
                            .setOrdering(Ordering.ASC)
                            .setPageSize(100)
                        if (token != null) b.setPageToken(token)
                        val res = store().readData(b.build())
                        all.addAll(res.dataList)
                        token = res.pageToken
                        pages++
                    } while (!token.isNullOrEmpty() && pages < 30)
                    all
                }
                val out = JSArray()
                for (point in points) {
                    val sessions = point.getValue(DataType.ExerciseType.SESSIONS) ?: continue
                    for (s in sessions) {
                        val o = JSObject()
                        o.put("uid", point.uid)
                        o.put("type", s.exerciseType.name)
                        o.put("start", s.startTime.toString())
                        o.put("end", s.endTime.toString())
                        o.put("durationSec", s.duration.seconds)
                        o.put("calories", s.calories.toDouble())
                        s.distance?.let { o.put("distance", it.toDouble()) }
                        s.meanHeartRate?.let { o.put("meanHr", it.toDouble()) }
                        s.maxHeartRate?.let { o.put("maxHr", it.toDouble()) }
                        s.meanSpeed?.let { o.put("meanSpeed", it.toDouble()) }
                        s.maxSpeed?.let { o.put("maxSpeed", it.toDouble()) }
                        s.customTitle?.let { o.put("title", it) }
                        s.swimmingLog?.let { sw ->
                            o.put("poolLength", sw.poolLength.toDouble())
                            o.put("poolUnit", sw.poolLengthUnit)
                            sw.totalDistance?.let { o.put("swimDistance", it.toDouble()) }
                            sw.totalDuration?.let { o.put("swimDurationSec", it.seconds) }
                            o.put("intervals", sw.swimmingIntervals?.size ?: 0)
                        }
                        if (withLog) {
                            val log = JSArray()
                            s.log?.forEach { l ->
                                val e = JSObject().put("t", l.timestamp.toEpochMilli())
                                l.heartRate?.let { e.put("hr", it.toDouble()) }
                                l.speed?.let { e.put("sp", it.toDouble()) }
                                log.put(e)
                            }
                            o.put("log", log)
                        }
                        out.put(o)
                    }
                }
                call.resolve(JSObject().put("sessions", out))
            } catch (e: Throwable) {
                call.reject(errorText(e))
            }
        }
    }
}
